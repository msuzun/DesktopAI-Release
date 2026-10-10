use super::*;
use std::collections::VecDeque;

#[derive(Clone, Copy, Debug)]
pub enum Evidence {
    NotNeeded,
    Missing,
    Compared(Difference),
}
pub fn compare_luma(a: &[u8], b: &[u8], width: u32, height: u32) -> Option<Difference> {
    if a.len() != b.len() || a.len() != width as usize * height as usize || a.is_empty() {
        return None;
    }
    let (mut sum, mut count) = (0u64, 0u64);
    let (mut left, mut top, mut right, mut bottom) = (width, height, 0, 0);
    for (i, (&x, &y)) in a.iter().zip(b).enumerate() {
        let delta = x.abs_diff(y);
        // A wider noise floor than adjacent-frame analysis rejects quantization
        // and anti-aliasing differences when comparing distant temporal samples.
        if delta > 12 {
            sum += delta as u64;
            count += 1;
            let (x, y) = (i as u32 % width, i as u32 / width);
            left = left.min(x);
            top = top.min(y);
            right = right.max(x + 1);
            bottom = bottom.max(y + 1);
        }
    }
    Some(Difference {
        score: sum as f64 / (a.len() as f64 * 255.),
        area: count as f64 / a.len() as f64,
        bounds: (count > 0).then_some(Bounds {
            x: left as f64 / width as f64,
            y: top as f64 / height as f64,
            width: right.saturating_sub(left) as f64 / width as f64,
            height: bottom.saturating_sub(top) as f64 / height as f64,
        }),
    })
}
pub fn iou(a: Bounds, b: Bounds) -> f64 {
    let intersection = ((a.x + a.width).min(b.x + b.width) - a.x.max(b.x)).max(0.)
        * ((a.y + a.height).min(b.y + b.height) - a.y.max(b.y)).max(0.);
    intersection / (a.width * a.height + b.width * b.height - intersection).max(f64::EPSILON)
}
#[derive(Clone, Debug)]
pub enum Action {
    Promote(Promotion),
    Confirm(EventId, KeyframeType, f64),
    Discard(EventId),
    Complete(VisualEvent),
}
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Statistics {
    pub samples: u64,
    pub created: u64,
    pub discarded: u64,
    pub stable_events: u64,
    pub transitions: u64,
    pub transient_candidates: u64,
    pub transient_confirmed: u64,
    pub transient_discarded: u64,
    pub persistent_events: u64,
    pub suppressed: u64,
    pub completed: u64,
    pub baseline_expired: u64,
}
#[derive(Default)]
struct Stability {
    since: Option<Instant>,
    samples: u32,
}
impl Stability {
    fn update(&mut self, quiet: bool, now: Instant) {
        if quiet {
            self.since.get_or_insert(now);
            self.samples += 1;
        } else {
            *self = Self::default();
        }
    }
    fn duration(&self, now: Instant) -> Duration {
        self.since
            .map_or(Duration::ZERO, |t| now.saturating_duration_since(t))
    }
    fn ready(&self, c: Config, now: Instant) -> bool {
        self.samples >= c.minimum_samples && self.duration(now) >= c.stability_window
    }
}
#[derive(Clone, Copy)]
struct Selection {
    at: Instant,
    quality: f64,
    replacements: u32,
}
struct Active {
    event: VisualEvent,
    baseline: SampleId,
    present_samples: u32,
    consistent_samples: u32,
    observations: u32,
    inconsistent_samples: u32,
    previous_bounds: Option<Bounds>,
    returning: Option<(SampleMetadata, u32)>,
    selection: Option<Selection>,
}
enum Phase {
    Warming,
    Stable,
    Transition(Active),
    Localized(Active),
}
struct Signature {
    bounds: Bounds,
    score: f64,
    until: Instant,
}
pub struct Detector {
    pub config: Config,
    pub generation: u64,
    next_sequence: u64,
    phase: Phase,
    baseline: Option<SampleMetadata>,
    last: Option<SampleMetadata>,
    quiet: Stability,
    last_comparison: Option<Instant>,
    cooldowns: VecDeque<Signature>,
    pub scene_sequence: u64,
    pub statistics: Statistics,
    pub last_stable: Option<Instant>,
}
impl Detector {
    pub fn latest_sample(&self) -> Option<SampleMetadata> {
        self.last
    }
    pub fn expire(&mut self, now: Instant) -> Option<EventId> {
        if self.last.is_some_and(|m| {
            now.saturating_duration_since(m.source_timestamp) > self.config.retention
        }) {
            let active = self.active().map(|e| e.id);
            self.statistics.discarded += u64::from(active.is_some());
            self.statistics.transient_discarded +=
                u64::from(matches!(self.phase, Phase::Localized(_)));
            self.phase = Phase::Warming;
            self.baseline = None;
            self.quiet = Stability::default();
            self.cooldowns.clear();
            active
        } else {
            None
        }
    }
    pub fn new(config: Config, generation: u64) -> Self {
        Self {
            config,
            generation,
            next_sequence: 0,
            phase: Phase::Warming,
            baseline: None,
            last: None,
            quiet: Stability::default(),
            last_comparison: None,
            cooldowns: VecDeque::with_capacity(8),
            scene_sequence: 0,
            statistics: Statistics::default(),
            last_stable: None,
        }
    }
    pub fn state(&self) -> &'static str {
        match &self.phase {
            Phase::Warming => "Warming",
            Phase::Stable => "Stable",
            Phase::Transition(_) => "Transition",
            Phase::Localized(a) if a.selection.is_some() => "TransientActive",
            Phase::Localized(_) => "TransientCandidate",
        }
    }
    pub fn active(&self) -> Option<VisualEvent> {
        match &self.phase {
            Phase::Transition(a) | Phase::Localized(a) => Some(a.event),
            _ => None,
        }
    }
    pub fn active_at_turn(&self) -> Option<VisualEvent> {
        let mut event = self.active()?;
        // Return confirmation takes several observations. Its first clean frame
        // already ends the visible transient for temporal selection.
        if let Phase::Localized(a) = &self.phase {
            event.end = a.returning.map(|(m, _)| m.into());
        }
        Some(event)
    }
    pub fn stable_duration(&self, now: Instant) -> Duration {
        self.quiet.duration(now)
    }
    pub fn baseline_id(&self, m: SampleMetadata) -> Option<SampleId> {
        match &self.phase {
            Phase::Transition(a) | Phase::Localized(a) => Some(a.baseline),
            Phase::Stable
                if self.last_comparison.is_none_or(|t| {
                    m.source_timestamp.saturating_duration_since(t)
                        >= self.config.baseline_check_interval
                }) || m.change.is_some_and(|c| {
                    c.changed_area_ratio >= self.config.start_area
                        && c.global_change_score >= self.config.start_score
                }) =>
            {
                self.baseline.map(|b| b.id)
            }
            _ => None,
        }
    }
    fn event(&mut self, m: SampleMetadata, kind: EventType) -> VisualEvent {
        self.next_sequence += 1;
        self.statistics.created += 1;
        VisualEvent {
            id: EventId {
                generation: self.generation,
                sequence: self.next_sequence,
            },
            kind,
            status: EventStatus::Candidate,
            start: m.into(),
            peak: m.into(),
            end: None,
            peak_score: m.change.map_or(0., |c| c.global_change_score),
            peak_area: m.change.map_or(0., |c| c.changed_area_ratio),
            bounds: m.change.and_then(|c| c.change_bounds),
            detection_confidence: 0.,
            scene_sequence: self.scene_sequence,
            keyframe: None,
        }
    }
    fn establish(&mut self, m: SampleMetadata, actions: &mut Vec<Action>) {
        self.scene_sequence += 1;
        let mut event = self.event(m, EventType::StableSceneEstablished);
        event.status = EventStatus::Completed;
        event.end = Some(m.into());
        event.detection_confidence = 0.95;
        event.scene_sequence = self.scene_sequence;
        actions.push(Action::Promote(Promotion {
            event: event.id,
            sample: m,
            kind: KeyframeType::Stable,
            status: KeyframeStatus::Confirmed,
            detection_confidence: event.detection_confidence,
            selection_confidence: 0.95,
            maximum_delta: self.config.correlation_delta,
        }));
        actions.push(Action::Complete(event));
        self.statistics.stable_events += 1;
        self.statistics.completed += 1;
        self.baseline = Some(m);
        self.last_stable = Some(m.source_timestamp);
        self.phase = Phase::Stable;
    }
    fn remember(&mut self, a: &Active, now: Instant) {
        if let Some(bounds) = a.previous_bounds {
            if self.cooldowns.len() == 8 {
                self.cooldowns.pop_front();
            }
            self.cooldowns.push_back(Signature {
                bounds,
                score: a.event.peak_score,
                until: now + self.config.cooldown,
            });
        }
    }
    fn discard(&mut self, a: Active, now: Instant, actions: &mut Vec<Action>) {
        actions.push(Action::Discard(a.event.id));
        self.statistics.discarded += 1;
        if a.event.kind != EventType::SceneTransition {
            self.statistics.transient_discarded += 1;
            self.remember(&a, now);
        }
        self.phase = Phase::Stable;
    }
    pub fn observe(&mut self, m: SampleMetadata, evidence: Evidence) -> Vec<Action> {
        let mut actions = Vec::new(); // Allocates only when an event produces an action.
        let now = m.source_timestamp;
        if self.last.is_some_and(|last| {
            m.id.temporal_generation != last.id.temporal_generation
                || m.id.temporal_sequence <= last.id.temporal_sequence
                || now < last.source_timestamp
        }) {
            return actions;
        }
        let gap = self.last.is_some_and(|last| {
            now.duration_since(last.source_timestamp) > self.config.maximum_sample_gap
        });
        self.last = Some(m);
        self.statistics.samples += 1;
        self.cooldowns.retain(|s| s.until > now);
        let quiet = m.change.is_none_or(|c| {
            c.global_change_score <= self.config.stable_score
                && c.changed_area_ratio <= self.config.stable_area
                && c.changed_tile_count <= self.config.stable_tiles
        });
        if gap {
            self.quiet = Stability::default();
        }
        self.quiet.update(quiet, now);
        if !matches!(evidence, Evidence::NotNeeded) {
            self.last_comparison = Some(now);
        }
        let diff = match evidence {
            Evidence::Compared(d) => Some(d),
            _ => None,
        };
        let phase = std::mem::replace(&mut self.phase, Phase::Warming);
        match phase {
            Phase::Warming => {
                if self.quiet.ready(self.config, now) {
                    self.establish(m, &mut actions);
                }
            }
            Phase::Stable => {
                self.phase = Phase::Stable;
                if let Some(d) = diff {
                    let meaningful =
                        d.area >= self.config.start_area && d.score >= self.config.start_score;
                    if meaningful {
                        let broad = d.area >= self.config.broad_area;
                        let suppressed = !broad
                            && d.bounds.is_some_and(|b| {
                                self.cooldowns.iter().any(|s| {
                                    iou(s.bounds, b) >= 0.65 && (s.score - d.score).abs() <= 0.08
                                })
                            });
                        if suppressed {
                            self.statistics.suppressed += 1;
                            return actions;
                        }
                        let kind = if broad {
                            EventType::SceneTransition
                        } else {
                            EventType::LocalizedTransient
                        };
                        let mut event = self.event(m, kind);
                        event.peak_score = d.score;
                        event.peak_area = d.area;
                        event.bounds = d.bounds;
                        let a = Active {
                            event,
                            baseline: self.baseline.unwrap().id,
                            present_samples: 1,
                            consistent_samples: 1,
                            observations: 1,
                            inconsistent_samples: 0,
                            previous_bounds: d.bounds,
                            returning: None,
                            selection: None,
                        };
                        self.quiet = Stability::default();
                        if broad {
                            self.statistics.transitions += 1;
                            self.phase = Phase::Transition(a);
                        } else {
                            self.statistics.transient_candidates += 1;
                            self.phase = Phase::Localized(a);
                        }
                    } else if quiet
                        && self.baseline.is_some_and(|b| {
                            now.duration_since(b.source_timestamp) > Duration::from_secs(1)
                        })
                    {
                        self.baseline = Some(m);
                    }
                } else if matches!(evidence, Evidence::Missing) {
                    self.statistics.baseline_expired += 1;
                    self.baseline = quiet.then_some(m);
                    self.phase = if quiet { Phase::Stable } else { Phase::Warming };
                }
            }
            Phase::Transition(mut a) => {
                if gap {
                    self.discard(a, now, &mut actions);
                    self.phase = Phase::Warming;
                    return actions;
                }
                if let Some(c) = m.change {
                    if c.global_change_score > a.event.peak_score {
                        a.event.peak = m.into();
                        a.event.peak_score = c.global_change_score;
                        a.event.peak_area = c.changed_area_ratio;
                        a.event.bounds = c.change_bounds;
                    }
                }
                a.event.status = EventStatus::Active;
                if self.quiet.ready(self.config, now) {
                    let returned = diff.is_some_and(|d| {
                        d.score <= self.config.return_score && d.area <= self.config.return_area
                    });
                    a.event.status = EventStatus::Completed;
                    a.event.end = Some(m.into());
                    a.event.detection_confidence = 0.9;
                    actions.push(Action::Complete(a.event));
                    self.statistics.completed += 1;
                    if returned {
                        let mut event = self.event(m, EventType::ReturnToStableState);
                        event.status = EventStatus::Completed;
                        event.end = Some(m.into());
                        event.detection_confidence = 0.9;
                        actions.push(Action::Complete(event));
                        self.statistics.completed += 1;
                        self.baseline = Some(m);
                        self.phase = Phase::Stable;
                    } else {
                        self.establish(m, &mut actions);
                    }
                } else {
                    self.phase = Phase::Transition(a);
                }
            }
            Phase::Localized(mut a) => {
                if gap || matches!(evidence, Evidence::Missing) {
                    self.statistics.baseline_expired +=
                        u64::from(matches!(evidence, Evidence::Missing));
                    self.discard(a, now, &mut actions);
                    self.phase = Phase::Warming;
                    return actions;
                }
                let Some(d) = diff else {
                    self.phase = Phase::Localized(a);
                    return actions;
                };
                let returned =
                    d.score <= self.config.return_score && d.area <= self.config.return_area;
                if returned {
                    let (first, count) = a.returning.get_or_insert((m, 0));
                    *count += 1;
                    if *count >= 2
                        && now.duration_since(first.source_timestamp) >= self.config.return_window
                    {
                        let duration = first
                            .source_timestamp
                            .duration_since(a.event.start.timestamp);
                        if duration >= self.config.transient_min
                            && duration <= self.config.transient_max
                            && a.present_samples >= self.config.minimum_samples
                            && a.event.detection_confidence >= self.config.provisional_confidence
                        {
                            a.event.status = EventStatus::Completed;
                            a.event.end = Some((*first).into());
                            a.event.detection_confidence =
                                (a.event.detection_confidence + 0.1).min(1.);
                            actions.push(Action::Confirm(
                                a.event.id,
                                KeyframeType::Transient,
                                a.event.detection_confidence,
                            ));
                            actions.push(Action::Complete(a.event));
                            self.statistics.transient_confirmed += 1;
                            self.statistics.completed += 1;
                            self.remember(&a, now);
                            self.baseline = Some(m);
                            self.phase = Phase::Stable;
                        } else {
                            self.discard(a, now, &mut actions);
                            self.baseline = Some(m);
                        }
                    } else {
                        self.phase = Phase::Localized(a);
                    }
                    return actions;
                }
                a.returning = None;
                a.observations += 1;
                if d.area >= self.config.broad_area {
                    actions.push(Action::Discard(a.event.id));
                    self.statistics.transient_discarded += 1;
                    a.event.kind = EventType::SceneTransition;
                    a.selection = None;
                    self.statistics.transitions += 1;
                    self.phase = Phase::Transition(a);
                    return actions;
                }
                let present =
                    d.area >= self.config.continue_area && d.score >= self.config.continue_score;
                let consistent = a
                    .previous_bounds
                    .zip(d.bounds)
                    .is_some_and(|(x, y)| iou(x, y) >= self.config.overlap);
                if present && consistent {
                    a.present_samples += 1;
                    a.consistent_samples += 1;
                    a.inconsistent_samples = 0;
                    a.previous_bounds = d.bounds;
                } else {
                    a.inconsistent_samples += 1;
                }
                if a.inconsistent_samples >= 3 {
                    self.discard(a, now, &mut actions);
                    return actions;
                }
                if d.score > a.event.peak_score {
                    a.event.peak = m.into();
                    a.event.peak_score = d.score;
                    a.event.peak_area = d.area;
                    a.event.bounds = d.bounds;
                }
                let duration = now.duration_since(a.event.start.timestamp);
                a.event.detection_confidence = (0.25
                    * (duration.as_secs_f64() / self.config.transient_min.as_secs_f64()).min(1.)
                    + 0.25
                        * (a.present_samples as f64 / self.config.minimum_samples as f64).min(1.)
                    + 0.25 * (a.consistent_samples as f64 / a.observations.max(1) as f64).min(1.)
                    + 0.25 * (d.area / (self.config.start_area * 2.)).min(1.))
                .clamp(0., 1.);
                if duration > self.config.transient_max && self.quiet.ready(self.config, now) {
                    a.event.kind = EventType::LocalizedPersistentChange;
                    a.event.status = EventStatus::Completed;
                    a.event.end = Some(m.into());
                    actions.push(Action::Confirm(
                        a.event.id,
                        KeyframeType::Stable,
                        a.event.detection_confidence,
                    ));
                    if a.selection.is_none() {
                        actions.push(Action::Promote(Promotion {
                            event: a.event.id,
                            sample: m,
                            kind: KeyframeType::Stable,
                            status: KeyframeStatus::Confirmed,
                            detection_confidence: a.event.detection_confidence,
                            selection_confidence: 0.9,
                            maximum_delta: self.config.correlation_delta,
                        }));
                    }
                    actions.push(Action::Complete(a.event));
                    self.statistics.persistent_events += 1;
                    self.statistics.completed += 1;
                    self.scene_sequence += 1;
                    self.baseline = Some(m);
                    self.last_stable = Some(now);
                    self.phase = Phase::Stable;
                    return actions;
                }
                if duration
                    > self
                        .config
                        .retention
                        .saturating_sub(self.config.stability_window)
                {
                    self.discard(a, now, &mut actions);
                    self.phase = Phase::Warming;
                    return actions;
                }
                let quality = (0.45 * (self.quiet.duration(now).as_secs_f64() / 0.2).min(1.)
                    + 0.30 * a.event.detection_confidence
                    + 0.25 * (d.score / 0.05).min(1.))
                .clamp(0., 1.);
                let better = a.selection.is_none_or(|s| {
                    s.replacements < self.config.maximum_replacements
                        && now.duration_since(s.at) >= self.config.replacement_interval
                        && quality >= s.quality + self.config.replacement_improvement
                });
                if present
                    && consistent
                    && duration >= self.config.transient_min
                    && a.present_samples >= self.config.minimum_samples
                    && a.event.detection_confidence >= self.config.provisional_confidence
                    && better
                {
                    actions.push(Action::Promote(Promotion {
                        event: a.event.id,
                        sample: m,
                        kind: KeyframeType::Transient,
                        status: KeyframeStatus::Provisional,
                        detection_confidence: a.event.detection_confidence,
                        selection_confidence: quality,
                        maximum_delta: self.config.correlation_delta,
                    }));
                    a.selection = Some(Selection {
                        at: now,
                        quality,
                        replacements: a.selection.map_or(0, |s| s.replacements + 1),
                    });
                    a.event.status = EventStatus::Active;
                }
                self.phase = Phase::Localized(a);
            }
        }
        actions
    }
}
