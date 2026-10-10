//! Sparse, opt-in M7 event persistence. This observer never runs on a capture,
//! analysis or audio thread, and never substitutes a current desktop capture.
use crate::{
    capture_backend::CaptureManager,
    persistent_memory::*,
    promoted_keyframes::PromotedKeyframeCache,
    session::Session,
    visual_events::{EventId, EventStatus, EventType, KeyframeStatus, VisualEvent},
};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const INTERVAL: Duration = Duration::from_secs(60);
type Fingerprint = [u8; 16 * 16 * 3];

pub struct AutomaticMemory {
    stopped: Arc<AtomicBool>,
}
impl AutomaticMemory {
    pub fn start(
        memory: Arc<MemoryService>,
        native: Arc<Mutex<Session>>,
        capture: Arc<Mutex<CaptureManager>>,
        run_id: String,
    ) -> Option<Self> {
        let stopped = Arc::new(AtomicBool::new(false));
        let stopping = stopped.clone();
        std::thread::Builder::new()
            .name("automatic-memory".into())
            .spawn(move || {
                let mut policy = SelectionPolicy::new(Instant::now());
                while !stopping.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(250));
                    let Some(gate) = memory.automatic_gate() else {
                        continue;
                    };
                    let now = Instant::now();
                    if !policy.observe_gate(gate.generation, gate.enabled, now) {
                        continue;
                    }
                    let Some(generation) = native
                        .try_lock()
                        .ok()
                        .and_then(|s| s.visual_access_generation().ok())
                    else {
                        continue;
                    };
                    let Some(events) = capture.try_lock().ok().and_then(|c| c.event_memory())
                    else {
                        continue;
                    };
                    let recent = events.recent_events(Duration::from_secs(5), now);
                    let Some((event, origin)) = policy.select(&recent, now) else {
                        continue;
                    };
                    let permitted = || {
                        !stopping.load(Ordering::Acquire)
                            && native
                                .try_lock()
                                .ok()
                                .is_some_and(|s| s.visual_access_valid(generation))
                    };
                    let _ = persist_selected(
                        &memory,
                        &events.keyframes(),
                        SelectedMemory {
                            event,
                            origin,
                            generation: gate.generation,
                            run_id: &run_id,
                        },
                        &mut policy,
                        permitted,
                    );
                }
            })
            .ok()?;
        Some(Self { stopped })
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }
}
impl Drop for AutomaticMemory {
    fn drop(&mut self) {
        self.stop();
    }
}

pub(crate) struct SelectionPolicy {
    generation: Option<u64>,
    cutoff: Instant,
    seen: VecDeque<EventId>,
    signatures: VecDeque<Fingerprint>,
    last_attempt: Option<Instant>,
}
impl SelectionPolicy {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            generation: None,
            cutoff: now,
            seen: VecDeque::with_capacity(64),
            signatures: VecDeque::with_capacity(32),
            last_attempt: None,
        }
    }
    pub(crate) fn observe_gate(&mut self, generation: u64, enabled: bool, now: Instant) -> bool {
        if self.generation != Some(generation) || !enabled {
            self.generation = Some(generation);
            self.cutoff = now;
            self.seen.clear();
            self.signatures.clear();
            return false;
        }
        enabled
    }
    fn eligible(&self, event: &VisualEvent, events: &[VisualEvent]) -> Option<CandidateOrigin> {
        if event.status != EventStatus::Completed
            || event.keyframe.is_none()
            || event.start.timestamp < self.cutoff
            || event.detection_confidence < 0.85
        {
            return None;
        }
        match event.kind {
            EventType::LocalizedPersistentChange
                if event.peak_area >= 0.08
                    && event.peak_score >= 0.025
                    && event.duration(Instant::now()) >= Duration::from_millis(1500) =>
            {
                Some(CandidateOrigin::MeaningfulStableState)
            }
            EventType::LocalizedTransient
                if event.peak_area >= 0.025
                    && event.peak_score >= 0.01
                    && event.duration(Instant::now()) >= Duration::from_millis(200) =>
            {
                Some(CandidateOrigin::ImportantTransient)
            }
            EventType::StableSceneEstablished
                if events.iter().any(|prior| {
                    prior.kind == EventType::SceneTransition
                        && prior.status == EventStatus::Completed
                        && prior.id.generation == event.id.generation
                        && prior.scene_sequence.checked_add(1) == Some(event.scene_sequence)
                        && prior.start.timestamp >= self.cutoff
                        && prior.end.is_some_and(|end| {
                            end.timestamp <= event.start.timestamp
                                && event.start.timestamp.duration_since(end.timestamp)
                                    <= Duration::from_secs(1)
                        })
                        && prior.peak_area >= 0.30
                        && prior.peak_score >= 0.025
                        && prior.detection_confidence >= 0.85
                }) =>
            {
                Some(CandidateOrigin::MeaningfulStableState)
            }
            _ => None,
        }
    }
    pub(crate) fn select(
        &mut self,
        events: &[VisualEvent],
        now: Instant,
    ) -> Option<(VisualEvent, CandidateOrigin)> {
        // Newest eligible moment first. Both the source and admission stay bounded.
        for event in events.iter().rev() {
            if self.seen.contains(&event.id) {
                continue;
            }
            let Some(origin) = self.eligible(event, events) else {
                continue;
            };
            if self.seen.len() == 64 {
                self.seen.pop_front();
            }
            self.seen.push_back(event.id);
            if self
                .last_attempt
                .is_some_and(|last| now.saturating_duration_since(last) < INTERVAL)
            {
                continue;
            }
            return Some((*event, origin));
        }
        None
    }
    fn similar(&self, signature: &Fingerprint) -> bool {
        self.signatures.iter().any(|previous| {
            previous
                .iter()
                .zip(signature)
                .map(|(a, b)| u64::from(a.abs_diff(*b)))
                .sum::<u64>()
                < (signature.len() * 12) as u64
        })
    }
}
fn fingerprint(image: &image::RgbaImage) -> Fingerprint {
    let small = image::imageops::resize(image, 16, 16, image::imageops::FilterType::Triangle);
    let mut result = [0; 16 * 16 * 3];
    for (index, pixel) in small.pixels().enumerate() {
        result[index * 3..index * 3 + 3].copy_from_slice(&pixel.0[..3]);
    }
    result
}

struct SelectedMemory<'a> {
    event: VisualEvent,
    origin: CandidateOrigin,
    generation: u64,
    run_id: &'a str,
}

/// The selected historical source is the only
/// permitted readback. Ordinary leases are released before persistence I/O.
fn persist_selected(
    memory: &MemoryService,
    cache: &PromotedKeyframeCache,
    selected: SelectedMemory<'_>,
    policy: &mut SelectionPolicy,
    permitted: impl Fn() -> bool,
) -> Result<MemoryRecord> {
    let SelectedMemory {
        event,
        origin,
        generation,
        run_id,
    } = selected;
    if !permitted() {
        return Err(MemoryError::new("MEMORY_CANCELLED"));
    }
    let ticket = memory.try_begin_automatic(generation)?;
    let id = event
        .keyframe
        .ok_or_else(|| MemoryError::new("MEMORY_CAPTURE_UNAVAILABLE"))?;
    let source = cache
        .keyframe(id, Instant::now())
        .ok_or_else(|| MemoryError::new("MEMORY_CAPTURE_UNAVAILABLE"))?;
    let metadata = source.metadata();
    if metadata.event != event.id
        || metadata.status != KeyframeStatus::Confirmed
        || metadata.source.source_timestamp < policy.cutoff
        || u64::from(metadata.source.width) * u64::from(metadata.source.height) > 16_777_216
    {
        return Err(MemoryError::new("MEMORY_CANCELLED"));
    }
    // Limit attempted readbacks as well as successful writes under slow/failing I/O.
    policy.last_attempt = Some(Instant::now());
    let image = if ticket.storage_mode() == StorageMode::Metadata {
        None
    } else {
        let mut preview = source
            .readback()
            .map_err(|_| MemoryError::new("MEMORY_CAPTURE_UNAVAILABLE"))?;
        Some(std::mem::take(&mut preview.image))
    };
    drop(source);
    if !permitted() {
        return Err(MemoryError::new("MEMORY_CANCELLED"));
    }
    let signature = image.as_ref().map(fingerprint);
    if signature.as_ref().is_some_and(|s| policy.similar(s)) {
        return Err(MemoryError::new("MEMORY_CANCELLED"));
    }
    let observed_at = now_ms().saturating_sub(
        metadata
            .source
            .source_timestamp
            .elapsed()
            .as_millis()
            .min(i64::MAX as u128) as i64,
    );
    let record = memory.save(
        ticket,
        MemoryCandidate {
            observed_at,
            session_id: format!("{run_id}-{}", metadata.source.capture_generation),
            label: String::new(),
            image,
            origin,
        },
    )?;
    if let Some(signature) = signature {
        if policy.signatures.len() == 32 {
            policy.signatures.pop_front();
        }
        policy.signatures.push_back(signature);
    }
    Ok(record)
}
