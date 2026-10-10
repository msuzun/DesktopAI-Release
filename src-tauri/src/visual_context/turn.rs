//! Deterministic, provider-independent selection with one bounded on-demand
//! capture when the compositor has no suitably recent current frame.
use super::*;
use crate::visual_events::EventType;
use serde::Serialize;

// At 30 Hz these span six observations. M7.6's 250 ms stability window
// normally starts before speech ends; we wait only its bounded remainder.
pub const ALIGNMENT: Duration = Duration::from_millis(200);
pub const STABILITY_WAIT: Duration = Duration::from_millis(200);
pub const TIER_C_AGE: Duration = Duration::from_millis(300);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub turn_id: String,
    pub reason: &'static str,
    pub source: &'static str,
    pub candidates: usize,
    pub scene: u64,
    pub stable: bool,
    pub event: Option<EventType>,
    pub turn_offset_ms: f64,
    pub frame_age_ms: f64,
    pub resolver_ms: f64,
    pub stability_wait_ms: f64,
    pub freshness_wait_ms: f64,
    pub turn_to_selected_ms: f64,
    pub selected_at_unix_ms: f64,
    pub source_timestamp_unix_ms: f64,
    pub turn_completed_at_unix_ms: f64,
    pub legacy_fallback: bool,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub resolved: u64,
    pub cancelled: u64,
    pub unavailable: u64,
    pub stable_immediate: u64,
    pub waited_for_stable: u64,
    pub stability_timeouts: u64,
    pub transient: u64,
    pub pre_transition: u64,
    pub latest: u64,
    pub legacy_current_fallback_count: u64,
    pub zero_wait: u64,
    pub waited: u64,
    pub total_wait_ms: f64,
    pub maximum_wait_ms: f64,
    pub total_resolver_ms: f64,
    pub maximum_resolver_ms: f64,
    pub total_offset_ms: f64,
    pub total_age_ms: f64,
    pub last: Option<Decision>,
}
impl Metrics {
    pub fn record(&mut self, d: Decision) {
        self.resolved += 1;
        self.stable_immediate += u64::from(d.reason == "StableLatestImmediate");
        self.waited_for_stable += u64::from(d.reason == "TransitionWaitedForStable");
        self.stability_timeouts += u64::from(d.reason == "TransitionTimeoutLatest");
        self.transient += u64::from(d.reason == "TurnAlignedTransient");
        self.pre_transition += u64::from(d.reason == "TurnAlignedPreTransition");
        self.latest += u64::from(d.reason == "FreshLatest");
        self.zero_wait += u64::from(d.stability_wait_ms == 0.);
        self.waited += u64::from(d.stability_wait_ms > 0.);
        self.total_wait_ms += d.stability_wait_ms;
        self.maximum_wait_ms = self.maximum_wait_ms.max(d.stability_wait_ms);
        self.total_resolver_ms += d.resolver_ms;
        self.maximum_resolver_ms = self.maximum_resolver_ms.max(d.resolver_ms);
        self.total_offset_ms += d.turn_offset_ms;
        self.total_age_ms += d.frame_age_ms;
        self.last = Some(d);
    }
}
pub struct Selection {
    pub source: Arc<dyn Asset>,
    pub decision: Decision,
}
fn acceptable(a: &Arc<dyn Asset>) -> bool {
    a.available() && a.info().timestamp.elapsed() <= HARD_AGE
}
fn keyframe(
    job: &Job,
    event: crate::visual_events::VisualEvent,
    reference: Instant,
) -> Option<Arc<dyn Asset>> {
    let asset = job.sources.keyframe(event.keyframe?)?;
    let info = asset.info();
    (acceptable(&asset)
        && info.timestamp.elapsed() <= TIER_C_AGE
        && offset(info.timestamp, reference).abs() <= millis(ALIGNMENT)
        && info.delta_ms <= 50.
        && info.timestamp
            >= event
                .start
                .timestamp
                .checked_sub(Duration::from_millis(50))
                .unwrap_or(event.start.timestamp)
        && event.end.is_none_or(|m| {
            info.timestamp < m.timestamp || event.kind == EventType::StableSceneEstablished
        }))
    .then_some(asset)
}
pub(super) fn resolve(
    shared: &Shared,
    job: &Job,
    reference: Instant,
    timings: &mut Timings,
) -> Result<Selection> {
    let result = resolve_inner(shared, job, reference, timings);
    if let Err(e) = &result {
        let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let m = &mut state.diagnostics.turn_sync;
        m.cancelled += u64::from(matches!(
            e.code,
            "cancelled" | "permission_denied" | "generation_changed"
        ));
        m.unavailable += u64::from(e.code == "current_unavailable");
    }
    result
}
fn resolve_inner(
    shared: &Shared,
    job: &Job,
    reference: Instant,
    timings: &mut Timings,
) -> Result<Selection> {
    let started = Instant::now();
    let generation = job.sources.generation();
    let signal = job.sources.signal();
    let mut revision = signal.as_ref().map_or(0, |s| s.revision());
    let state = job.sources.turn_state(reference);
    let mut decision = Decision {
        turn_id: job.request.turn_id.clone(),
        reason: "FreshLatest",
        source: "LatestTierB",
        candidates: 0,
        scene: state.scene,
        stable: state.stable,
        event: state.at_turn.map(|e| e.kind),
        turn_offset_ms: 0.,
        frame_age_ms: 0.,
        resolver_ms: 0.,
        stability_wait_ms: 0.,
        freshness_wait_ms: 0.,
        turn_to_selected_ms: 0.,
        selected_at_unix_ms: 0.,
        source_timestamp_unix_ms: 0.,
        turn_completed_at_unix_ms: unix(reference),
        legacy_fallback: job.sources.compatibility(),
    };
    let mut choose = |source: Option<Arc<dyn Asset>>, kind: &'static str| {
        decision.candidates += usize::from(source.is_some());
        source.filter(acceptable).map(|a| (a, kind))
    };
    let mut selected;
    let mut reason = "FreshLatest";
    if job.sources.compatibility() {
        shared
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .diagnostics
            .turn_sync
            .legacy_current_fallback_count += 1;
        selected = choose(job.sources.latest()?, "LegacyCapture");
        reason = "LegacyFallback";
    } else {
        let lower = reference.checked_sub(ALIGNMENT).unwrap_or(reference);
        let upper = reference + ALIGNMENT;
        if let Some(event) = state
            .at_turn
            .filter(|e| e.kind == EventType::LocalizedTransient)
        {
            let end = event
                .end
                .map_or(upper, |m| {
                    m.timestamp
                        .checked_sub(Duration::from_nanos(1))
                        .unwrap_or(m.timestamp)
                })
                .min(upper);
            selected = choose(
                job.sources
                    .near(reference, lower.max(event.start.timestamp), end)?,
                "TurnNearestTierB",
            )
            .or_else(|| choose(keyframe(job, event, reference), "TransientTierC"));
            // Never substitute the clean screen for an unavailable turn transient.
            reason = "TurnAlignedTransient";
            decision.scene = event.scene_sequence;
        } else if let Some(change) = state.post_turn_change.filter(|_| state.at_turn.is_none()) {
            selected = choose(
                job.sources.near(
                    reference,
                    lower,
                    upper.min(
                        change
                            .checked_sub(Duration::from_nanos(1))
                            .unwrap_or(change),
                    ),
                )?,
                "TurnNearestTierB",
            );
            reason = "TurnAlignedPreTransition";
        } else if let Some(event) = state
            .at_turn
            .filter(|e| e.kind == EventType::SceneTransition)
        {
            // The deadline is never extended by motion or spurious notifications.
            let deadline = (started + STABILITY_WAIT).min(reference + ALIGNMENT);
            let mut current = state;
            let mut wait_started = None;
            loop {
                check(shared, job, Some(generation))?;
                if current.stable && current.observed_at.is_some_and(|t| t >= reference) {
                    selected = choose(job.sources.latest()?, "CurrentStableTierB")
                        .filter(|(a, _)| a.info().timestamp >= event.start.timestamp);
                    if selected.is_some() {
                        reason = "TransitionWaitedForStable";
                        decision.scene = current.scene;
                        decision.stable = true;
                        break;
                    }
                }
                if Instant::now() >= deadline || signal.is_none() {
                    selected = choose(job.sources.latest()?, "LatestTierB")
                        .filter(|(a, _)| a.info().timestamp >= event.start.timestamp);
                    reason = "TransitionTimeoutLatest";
                    break;
                }
                wait_started.get_or_insert_with(Instant::now);
                if let Some(signal) = &signal {
                    signal.wait(revision, deadline);
                    revision = signal.revision();
                }
                timings.wait_ms = wait_started.map_or(0., |t| millis(t.elapsed()));
                check(shared, job, Some(generation))?;
                current = job.sources.turn_state(reference);
            }
            decision.stability_wait_ms = wait_started.map_or(0., |t| millis(t.elapsed()));
        } else {
            selected = choose(
                job.sources.near(reference, lower, upper)?,
                "TurnNearestTierB",
            );
            if selected.is_none() {
                selected = choose(job.sources.latest()?, "LatestTierB");
            }
            if state.stable
                && selected.as_ref().is_some_and(|(a, _)| {
                    offset(a.info().timestamp, reference).abs() <= millis(ALIGNMENT)
                })
            {
                reason = "StableLatestImmediate";
            } else if selected.is_none() && state.stable {
                if let Some(event) = state
                    .stable_event
                    .filter(|e| e.scene_sequence == state.scene)
                {
                    selected = choose(keyframe(job, event, reference), "StableTierC");
                    reason = "StableCurrent";
                }
            }
            // WGC is damage-driven: on an unchanged desktop its latest frame
            // can be seconds old. Waiting for damage cannot refresh that frame.
            // Capture once while the endpoint is still in range; keep both its
            // real timestamp and the usual alignment/delivery limits. This is
            // deliberately outside the transient and pre-transition branches.
            if selected
                .as_ref()
                .is_none_or(|(a, _)| a.info().timestamp < lower)
                && (!job.request.select_only || reference.elapsed() <= ALIGNMENT)
            {
                check(shared, job, Some(generation))?;
                let capture_started = Instant::now();
                let captured = job.sources.capture_current();
                timings.capture_ms += millis(capture_started.elapsed());
                let captured = captured?;
                if captured.is_some() {
                    selected = choose(captured, "OnDemandCapture");
                    reason = "OnDemandCurrent";
                    decision.legacy_fallback = true;
                    shared
                        .state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .diagnostics
                        .turn_sync
                        .legacy_current_fallback_count += 1;
                }
                check(shared, job, Some(generation))?;
            }
            // Keep M7.7 bounded freshness behavior, using event notifications in
            // the native pipeline. A turn-near state is already acceptable.
            if selected.as_ref().is_none_or(|(a, _)| {
                a.info().timestamp.elapsed() > PREFERRED_AGE
                    && offset(a.info().timestamp, reference).abs() > millis(ALIGNMENT)
            }) {
                let wait = Instant::now();
                let deadline = wait + FRESH_WAIT;
                loop {
                    check(shared, job, Some(generation))?;
                    let after = selected.as_ref().map(|(a, _)| a.info().cursor);
                    drop(selected.take());
                    if let Some(signal) = &signal {
                        signal.wait(revision, deadline);
                        revision = signal.revision();
                        timings.wait_ms = millis(wait.elapsed());
                        check(shared, job, Some(generation))?;
                        selected = choose(job.sources.latest()?, "LatestTierB");
                    } else {
                        selected = choose(job.sources.newer(after, deadline)?, "LatestTierB");
                    }
                    if selected
                        .as_ref()
                        .is_some_and(|(a, _)| a.info().timestamp.elapsed() <= PREFERRED_AGE)
                        || Instant::now() >= deadline
                        || signal.is_none()
                    {
                        break;
                    }
                }
                if selected.is_none() {
                    selected = choose(job.sources.latest()?, "LatestTierB");
                }
                decision.freshness_wait_ms = millis(wait.elapsed());
            }
        }
    }
    timings.wait_ms = decision.stability_wait_ms + decision.freshness_wait_ms;
    check(shared, job, Some(generation))?;
    let (source, kind) = selected.ok_or_else(|| error("current_unavailable"))?;
    decision.reason = reason;
    decision.source = kind;
    decision.turn_offset_ms = offset(source.info().timestamp, reference);
    decision.frame_age_ms = millis(source.info().timestamp.elapsed());
    decision.resolver_ms = millis(started.elapsed());
    decision.turn_to_selected_ms = millis(reference.elapsed());
    decision.selected_at_unix_ms = unix(Instant::now());
    decision.source_timestamp_unix_ms = unix(source.info().timestamp);
    Ok(Selection { source, decision })
}
