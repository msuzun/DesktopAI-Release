use super::*;
use crate::{
    promoted_keyframes::{self, Failure, PromotedKeyframeCache},
    recent_gpu_cache::RecentGpuFrameCache,
    temporal_memory::TemporalMemory,
};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    thread::JoinHandle,
};

fn generation() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}
struct Runtime {
    detector: Detector,
    timeline: VisualEventTimeline,
    cache: PromotedKeyframeCache,
    temporal_generation: Option<u64>,
    stopped: bool,
    error: Option<&'static str>,
    started: Instant,
    cpu_samples: u64,
    total_cpu_ms: f64,
    max_cpu_ms: f64,
}
impl Runtime {
    fn new() -> Self {
        let config = Config::default();
        let id = generation();
        Self {
            detector: Detector::new(config, id),
            timeline: VisualEventTimeline::new(config.timeline_capacity, config.retention),
            cache: PromotedKeyframeCache::new(Default::default(), id),
            temporal_generation: None,
            stopped: false,
            error: None,
            started: Instant::now(),
            cpu_samples: 0,
            total_cpu_ms: 0.,
            max_cpu_ms: 0.,
        }
    }
    fn reset(&mut self) {
        let config = self.detector.config;
        let id = generation();
        self.detector = Detector::new(config, id);
        self.timeline.clear();
        self.cache.clear(id);
        self.temporal_generation = None;
        self.started = Instant::now();
        self.cpu_samples = 0;
        self.total_cpu_ms = 0.;
        self.max_cpu_ms = 0.;
        self.error = None;
    }
    fn prune(&mut self, now: Instant) {
        if let Some(id) = self.detector.expire(now) {
            self.cache.discard(id);
        }
        self.cache.prune(now);
        self.timeline.prune(now);
        let available = self.cache.metadata_snapshot(now);
        self.timeline
            .reconcile_keyframes(|id| available.iter().any(|m| m.id == id));
    }
    fn process(
        &mut self,
        m: SampleMetadata,
        history: &TemporalMemory,
        recent: &RecentGpuFrameCache,
    ) {
        if self.stopped {
            return;
        }
        if self.temporal_generation != Some(m.id.temporal_generation) {
            self.reset();
            self.temporal_generation = Some(m.id.temporal_generation);
        }
        let started = Instant::now();
        let baseline = self.detector.baseline_id(m);
        let actions = history.with_luma_pair(m.id, baseline, started, |current, pixels, old| {
            let evidence = match (baseline, old) {
                (None, _) => Evidence::NotNeeded,
                (Some(_), None) => Evidence::Missing,
                (Some(_), Some(old)) => compare_luma(
                    old,
                    pixels,
                    current.geometry.analysis_width,
                    current.geometry.analysis_height,
                )
                .map_or(Evidence::Missing, Evidence::Compared),
            };
            self.detector.observe(current, evidence)
        });
        let ms = started.elapsed().as_secs_f64() * 1000.;
        self.cpu_samples += 1;
        self.total_cpu_ms += ms;
        self.max_cpu_ms = self.max_cpu_ms.max(ms);
        let Ok(actions) = actions else {
            return;
        };
        for action in actions {
            match action {
                Action::Promote(request) => {
                    if request.event.generation != self.detector.generation {
                        continue;
                    }
                    // Coordinator owns correlation and promotion, never detector math.
                    let target = request.sample.into();
                    match recent.correlate(target, self.detector.config.correlation_delta) {
                        Some(matched) => {
                            let result = self.cache.promote(
                                &matched.frame,
                                request,
                                matched.kind,
                                matched.delta,
                                Instant::now(),
                            );
                            // The source lease ends here. Tier C never pins Tier B for retention.
                            if matches!(
                                result,
                                Err(Failure::DeviceLost | Failure::GenerationMismatch)
                            ) {
                                self.reset();
                                break;
                            }
                        }
                        None => {
                            let reason = if recent
                                .nearest_to(
                                    request.sample.capture_generation,
                                    request.sample.source_timestamp,
                                    Duration::from_secs(5),
                                )
                                .is_some()
                            {
                                Failure::TemporalDeltaTooLarge
                            } else {
                                Failure::NoTierBMatch
                            };
                            self.cache.record_failure(reason);
                        }
                    }
                }
                Action::Confirm(id, kind, confidence) => {
                    self.cache.confirm(id, kind, confidence, Instant::now());
                }
                Action::Discard(id) => self.cache.discard(id),
                Action::Complete(mut event) => {
                    if event.id.generation != self.detector.generation {
                        continue;
                    }
                    event.keyframe = self
                        .cache
                        .keyframes_for_event(event.id, Instant::now())
                        .into_iter()
                        .find(|m| m.status == KeyframeStatus::Confirmed)
                        .map(|m| m.id);
                    self.timeline.insert(event, Instant::now());
                }
            }
        }
        self.prune(Instant::now());
    }
}
#[derive(Clone)]
pub struct EventMemory(Arc<Mutex<Runtime>>, Arc<AtomicU64>, Arc<StateSignal>);
impl EventMemory {
    pub fn generation(&self) -> u64 {
        self.lock().detector.generation
    }
    fn new() -> Self {
        Self(
            Arc::new(Mutex::new(Runtime::new())),
            Arc::new(AtomicU64::new(0)),
            Arc::new(StateSignal::default()),
        )
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn clear(&self) {
        let mut r = self.lock();
        if !r.stopped {
            r.reset();
        }
        self.2.notify();
    }
    pub fn stop(&self) {
        let mut r = self.lock();
        r.stopped = true;
        r.reset();
        r.cache.stop();
        self.2.notify();
    }
    pub fn signal(&self) -> Arc<StateSignal> {
        self.2.clone()
    }
    pub fn turn_state(&self, reference: Instant) -> TurnState {
        let mut r = self.lock();
        let now = Instant::now();
        r.prune(now);
        let mut events = r.timeline.recent_events(r.detector.config.retention, now);
        if let Some(mut active) = r.detector.active_at_turn() {
            active.keyframe = r
                .cache
                .keyframes_for_event(active.id, now)
                .last()
                .map(|m| m.id);
            events.push(active);
        }
        let changes = |e: &&VisualEvent| {
            matches!(
                e.kind,
                EventType::SceneTransition
                    | EventType::LocalizedTransient
                    | EventType::LocalizedPersistentChange
            )
        };
        let at_turn = events
            .iter()
            .filter(changes)
            .filter(|e| {
                e.start.timestamp <= reference && e.end.is_none_or(|m| m.timestamp > reference)
            })
            .max_by_key(|e| e.start.timestamp)
            .copied();
        let post_turn_change = events
            .iter()
            .filter(changes)
            .filter(|e| e.start.timestamp > reference)
            .map(|e| e.start.timestamp)
            .min();
        let stable = !r.stopped && r.detector.state() == "Stable";
        let stable_event = stable
            .then(|| {
                events
                    .iter()
                    .filter(|e| {
                        e.kind == EventType::StableSceneEstablished
                            && e.scene_sequence == r.detector.scene_sequence
                    })
                    .max_by_key(|e| e.start.timestamp)
                    .copied()
            })
            .flatten();
        TurnState {
            observed_at: r.detector.latest_sample().map(|m| m.source_timestamp),
            scene: r.detector.scene_sequence,
            stable,
            stable_event,
            at_turn,
            post_turn_change,
        }
    }
    pub fn keyframes(&self) -> PromotedKeyframeCache {
        self.lock().cache.clone()
    }
    pub fn recent_events(&self, duration: Duration, now: Instant) -> Vec<VisualEvent> {
        let mut r = self.lock();
        r.prune(now);
        r.timeline.recent_events(duration, now)
    }
    pub fn events_between(&self, start: Instant, end: Instant, now: Instant) -> Vec<VisualEvent> {
        let mut r = self.lock();
        r.prune(now);
        r.timeline.events_between(start, end, now)
    }
    pub fn diagnostics(&self, now: Instant) -> Diagnostics {
        let mut r = self.lock();
        r.prune(now);
        let config = r.detector.config;
        let events = r
            .timeline
            .recent_events(config.retention, now)
            .into_iter()
            .map(|e| EventView::new(e, now))
            .collect();
        let cache = r.cache.diagnostics(now);
        let keyframes = r
            .cache
            .metadata_snapshot(now)
            .into_iter()
            .map(|m| KeyframeView {
                id: m.id,
                event: m.event,
                kind: m.kind,
                status: m.status,
                age_ms: age(now, m.source.source_timestamp),
                source_frame_id: m.source.source_frame_id,
                perception_sequence: m.source.perception_sequence,
                analysis_sequence: m.source.analysis_sequence,
                temporal_id: m.desired_temporal_id,
                tier_b_id: m.source.id,
                width: m.source.width,
                height: m.source.height,
                detection_confidence: m.detection_confidence,
                selection_confidence: m.selection_confidence,
                correlation: m.correlation,
                correlation_delta_ms: m.correlation_delta.as_secs_f64() * 1000.,
            })
            .collect();
        let elapsed = now
            .saturating_duration_since(r.started)
            .as_secs_f64()
            .max(1.);
        Diagnostics {
            updates_dropped: self.1.load(Ordering::Relaxed),
            last_source_frame_id: r.detector.latest_sample().map(|m| m.source_frame_id),
            state: if r.stopped {
                "Stopped"
            } else {
                r.detector.state()
            },
            generation: r.detector.generation,
            temporal_generation: r.temporal_generation,
            active: r.detector.active().map(|e| EventView::new(e, now)),
            stable_duration_ms: r.detector.stable_duration(now).as_secs_f64() * 1000.,
            scene_sequence: r.detector.scene_sequence,
            last_stable_age_ms: r.detector.last_stable.map(|t| age(now, t)),
            statistics: r.detector.statistics,
            events,
            timeline_capacity: r.timeline.capacity(),
            keyframes,
            events_per_minute: r.detector.statistics.completed as f64 * 60. / elapsed,
            promotions_per_minute: cache.statistics.succeeded as f64 * 60. / elapsed,
            average_detector_cpu_ms: if r.cpu_samples == 0 {
                0.
            } else {
                r.total_cpu_ms / r.cpu_samples as f64
            },
            maximum_detector_cpu_ms: r.max_cpu_ms,
            stability_ms: config.stability_window.as_millis() as u64,
            transient_min_ms: config.transient_min.as_millis() as u64,
            transient_max_ms: config.transient_max.as_millis() as u64,
            cooldown_ms: config.cooldown.as_millis() as u64,
            correlation_limit_ms: config.correlation_delta.as_millis() as u64,
            retention_seconds: config.retention.as_secs_f64(),
            tier_c: cache,
            error: r.error,
        }
    }
}
fn age(now: Instant, time: Instant) -> f64 {
    now.saturating_duration_since(time).as_secs_f64() * 1000.
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    pub id: EventId,
    pub kind: EventType,
    pub status: EventStatus,
    pub start_age_ms: f64,
    pub peak_age_ms: f64,
    pub end_age_ms: Option<f64>,
    pub start_sequence: u64,
    pub peak_sequence: u64,
    pub end_sequence: Option<u64>,
    pub duration_ms: f64,
    pub peak_score: f64,
    pub peak_area: f64,
    pub bounds: Option<Bounds>,
    pub detection_confidence: f64,
    pub scene_sequence: u64,
    pub keyframe: Option<KeyframeId>,
}
impl EventView {
    fn new(e: VisualEvent, now: Instant) -> Self {
        Self {
            id: e.id,
            kind: e.kind,
            status: e.status,
            start_age_ms: age(now, e.start.timestamp),
            peak_age_ms: age(now, e.peak.timestamp),
            end_age_ms: e.end.map(|m| age(now, m.timestamp)),
            start_sequence: e.start.temporal_id.temporal_sequence,
            peak_sequence: e.peak.temporal_id.temporal_sequence,
            end_sequence: e.end.map(|m| m.temporal_id.temporal_sequence),
            duration_ms: e.duration(now).as_secs_f64() * 1000.,
            peak_score: e.peak_score,
            peak_area: e.peak_area,
            bounds: e.bounds,
            detection_confidence: e.detection_confidence,
            scene_sequence: e.scene_sequence,
            keyframe: e.keyframe,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyframeView {
    pub id: KeyframeId,
    pub event: EventId,
    pub kind: KeyframeType,
    pub status: KeyframeStatus,
    pub age_ms: f64,
    pub source_frame_id: u64,
    pub perception_sequence: u64,
    pub analysis_sequence: u64,
    pub temporal_id: SampleId,
    pub tier_b_id: crate::recent_gpu_cache::FrameId,
    pub width: u32,
    pub height: u32,
    pub detection_confidence: f64,
    pub selection_confidence: f64,
    pub correlation: crate::recent_gpu_cache::MatchKind,
    pub correlation_delta_ms: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub updates_dropped: u64,
    pub last_source_frame_id: Option<u64>,
    pub state: &'static str,
    pub generation: u64,
    pub temporal_generation: Option<u64>,
    pub active: Option<EventView>,
    pub stable_duration_ms: f64,
    pub scene_sequence: u64,
    pub last_stable_age_ms: Option<f64>,
    pub statistics: super::detector::Statistics,
    pub events: Vec<EventView>,
    pub timeline_capacity: usize,
    pub keyframes: Vec<KeyframeView>,
    pub events_per_minute: f64,
    pub promotions_per_minute: f64,
    pub average_detector_cpu_ms: f64,
    pub maximum_detector_cpu_ms: f64,
    pub stability_ms: u64,
    pub transient_min_ms: u64,
    pub transient_max_ms: u64,
    pub cooldown_ms: u64,
    pub correlation_limit_ms: u64,
    pub retention_seconds: f64,
    pub tier_c: promoted_keyframes::Diagnostics,
    pub error: Option<&'static str>,
}
impl Default for Diagnostics {
    fn default() -> Self {
        let memory = EventMemory::new();
        memory.stop();
        memory.diagnostics(Instant::now())
    }
}
struct Input {
    pending: Mutex<Option<(u64, SampleMetadata)>>,
    epoch: AtomicU64,
    stopped: AtomicBool,
    dropped: Arc<AtomicU64>,
}
#[derive(Clone)]
pub struct EventSink {
    input: Arc<Input>,
    wake: SyncSender<()>,
    memory: EventMemory,
}
impl EventSink {
    pub fn submit(&self, m: SampleMetadata) {
        if self.input.stopped.load(Ordering::Acquire) {
            return;
        }
        let Ok(mut pending) = self.input.pending.try_lock() else {
            self.input.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };
        if self.input.stopped.load(Ordering::Acquire) {
            return;
        }
        if pending.is_some() {
            self.input.dropped.fetch_add(1, Ordering::Relaxed);
        }
        *pending = Some((self.input.epoch.load(Ordering::Acquire), m));
        drop(pending);
        let _ = self.wake.try_send(());
    }
    pub fn invalidate(&self) {
        self.input.epoch.fetch_add(1, Ordering::AcqRel);
        self.input
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        self.memory.clear();
    }
    pub fn stop(&self) {
        self.input.stopped.store(true, Ordering::Release);
        self.input.epoch.fetch_add(1, Ordering::AcqRel);
        self.input
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        self.memory.stop();
        let _ = self.wake.try_send(());
    }
}
pub struct EventEngine {
    sink: EventSink,
    worker: Option<JoinHandle<()>>,
}
impl EventEngine {
    pub fn start(history: TemporalMemory, recent: RecentGpuFrameCache) -> Self {
        let memory = EventMemory::new();
        let (wake, receiver) = mpsc::sync_channel(1);
        let input = Arc::new(Input {
            pending: Mutex::new(None),
            epoch: AtomicU64::new(1),
            stopped: AtomicBool::new(false),
            dropped: memory.1.clone(),
        });
        let sink = EventSink {
            input: input.clone(),
            wake,
            memory: memory.clone(),
        };
        let worker = std::thread::Builder::new()
            .name("local-visual-events".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    while !input.stopped.load(Ordering::Acquire) {
                        let _ = receiver.recv_timeout(Duration::from_millis(20));
                        let next = input
                            .pending
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .take();
                        let mut r = memory.lock();
                        if input.stopped.load(Ordering::Acquire) {
                            break;
                        }
                        if let Some((epoch, m)) = next {
                            if epoch == input.epoch.load(Ordering::Acquire) {
                                r.process(m, &history, &recent);
                                memory.2.notify();
                            }
                        } else {
                            r.prune(Instant::now());
                        }
                    }
                }));
                if result.is_err() {
                    memory.stop();
                    memory.lock().error =
                        Some("Event worker unavailable; realtime perception continues.");
                }
            })
            .ok();
        if worker.is_none() {
            sink.stop();
            sink.memory.lock().error = Some("Event worker could not start.");
        }
        Self { sink, worker }
    }
    pub fn sink(&self) -> EventSink {
        self.sink.clone()
    }
    pub fn memory(&self) -> EventMemory {
        self.sink.memory.clone()
    }
    pub fn request_stop(&self) {
        self.sink.stop();
    }
    pub fn stop(&mut self) {
        self.request_stop();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for EventEngine {
    fn drop(&mut self) {
        self.stop();
    }
}
