use super::*;
use crate::{
    recent_gpu_cache::{
        self,
        gpu::{PreviewImage, PreviewSource},
        FrameLease,
    },
    visual_events::Promotion,
};
use std::sync::atomic::{AtomicU64, Ordering};
use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};
fn generation() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}
struct Store {
    config: Config,
    generation: u64,
    event_generation: u64,
    stopped: bool,
    pool: Option<Pool<ID3D11Texture2D>>,
    layout: Option<(u64, u64, u32, u32, u64)>,
    device: Option<ID3D11Device>,
    budget: Option<Budget>,
    statistics: Statistics,
    failed: bool,
}
impl Store {
    fn clear(&mut self, event_generation: u64) {
        self.pool = None;
        self.layout = None;
        self.device = None;
        self.budget = None;
        self.generation = generation();
        self.event_generation = event_generation;
        self.failed = false;
    }
}
#[derive(Clone)]
pub struct PromotedKeyframeCache(Arc<Mutex<Store>>);
#[derive(Clone)]
pub struct KeyframeLease {
    metadata: Metadata,
    resource: Arc<Mutex<Resource<ID3D11Texture2D>>>,
    retention: Duration,
    turn_reserved: bool,
}
impl KeyframeLease {
    pub fn metadata(&self) -> Metadata {
        self.metadata
    }
    pub fn is_available(&self) -> bool {
        let r = self.resource.lock().unwrap_or_else(|e| e.into_inner());
        r.id == Some(self.metadata.id)
            && (r.queryable || self.turn_reserved)
            && r.value.is_some()
            && self.metadata.source.source_timestamp.elapsed() <= self.retention
    }
    pub fn readback(&self) -> recent_gpu_cache::Result<PreviewImage> {
        recent_gpu_cache::gpu::readback(self)
    }
}
impl PreviewSource for KeyframeLease {
    fn dimensions(&self) -> (u32, u32) {
        (self.metadata.source.width, self.metadata.source.height)
    }
    fn is_available(&self) -> bool {
        self.is_available()
    }
    fn device(&self) -> recent_gpu_cache::Result<ID3D11Device> {
        let r = self.resource.lock().unwrap_or_else(|e| e.into_inner());
        if r.id != Some(self.metadata.id)
            || (!r.queryable && !self.turn_reserved)
            || self.metadata.source.source_timestamp.elapsed() > self.retention
        {
            return Err(recent_gpu_cache::CacheError::Expired);
        }
        unsafe {
            r.value
                .as_ref()
                .ok_or(recent_gpu_cache::CacheError::Expired)?
                .GetDevice()
        }
        .map_err(|_| recent_gpu_cache::CacheError::DeviceLost)
    }
    fn copy_to(&self, destination: &ID3D11Texture2D) -> recent_gpu_cache::Result<()> {
        let r = self.resource.lock().unwrap_or_else(|e| e.into_inner());
        if r.id != Some(self.metadata.id)
            || (!r.queryable && !self.turn_reserved)
            || self.metadata.source.source_timestamp.elapsed() > self.retention
        {
            return Err(recent_gpu_cache::CacheError::Expired);
        }
        let source = r
            .value
            .as_ref()
            .ok_or(recent_gpu_cache::CacheError::Expired)?;
        recent_gpu_cache::gpu::copy_texture(source, destination)
    }
}
impl PromotedKeyframeCache {
    pub fn new(config: Config, event_generation: u64) -> Self {
        Self(Arc::new(Mutex::new(Store {
            config,
            generation: generation(),
            event_generation,
            stopped: false,
            pool: None,
            layout: None,
            device: None,
            budget: None,
            statistics: Statistics::default(),
            failed: false,
        })))
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Store> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn clear(&self, event_generation: u64) {
        let mut s = self.lock();
        if !s.stopped {
            s.clear(event_generation);
        }
    }
    pub fn stop(&self) {
        let mut s = self.lock();
        s.clear(0);
        s.stopped = true;
    }
    pub fn prune(&self, now: Instant) {
        if let Some(pool) = &mut self.lock().pool {
            pool.prune(now);
        }
    }
    pub fn record_failure(&self, error: Failure) {
        let mut s = self.lock();
        s.statistics.attempted += 1;
        s.statistics.failure(error);
    }
    pub fn promote(
        &self,
        source: &FrameLease,
        request: Promotion,
        correlation: MatchKind,
        delta: Duration,
        now: Instant,
    ) -> Result<KeyframeId, Failure> {
        let mut s = self.lock();
        s.statistics.attempted += 1;
        let result = (|| {
            if s.stopped || request.event.generation != s.event_generation {
                return Err(Failure::GenerationMismatch);
            }
            let m = source.metadata();
            let actual_delta = if m.source_timestamp >= request.sample.source_timestamp {
                m.source_timestamp - request.sample.source_timestamp
            } else {
                request.sample.source_timestamp - m.source_timestamp
            };
            if actual_delta != delta || actual_delta > request.maximum_delta {
                return Err(Failure::TemporalDeltaTooLarge);
            }
            if (correlation == MatchKind::ExactSource
                && m.source_frame_id != request.sample.source_frame_id)
                || (correlation == MatchKind::ExactPerception
                    && m.perception_sequence != request.sample.perception_sequence)
            {
                return Err(Failure::GenerationMismatch);
            }
            if m.capture_generation != request.sample.capture_generation
                || now.saturating_duration_since(m.source_timestamp) > s.config.retention
            {
                return Err(Failure::GenerationMismatch);
            }
            let device = source.device().map_err(|_| Failure::ResourceUnavailable)?;
            let layout = (
                m.capture_generation,
                m.id.cache_generation,
                m.width,
                m.height,
                request.sample.id.temporal_generation,
            );
            if s.layout.is_some_and(|old| old != layout)
                || s.device.as_ref().is_some_and(|old| old != &device)
            {
                // The owner normally resets first. Reject an unexpected topology
                // boundary instead of mixing old events with new textures.
                let event_generation = s.event_generation;
                s.clear(event_generation);
                return Err(Failure::GenerationMismatch);
            }
            if s.failed {
                return Err(Failure::ResourceUnavailable);
            }
            if s.pool.is_none() {
                let budget = s.config.budget(m.width, m.height)?;
                let resources = allocate_up_to(budget.capacity, || {
                    let mut texture = None;
                    unsafe {
                        device.CreateTexture2D(
                            &D3D11_TEXTURE2D_DESC {
                                Width: m.width,
                                Height: m.height,
                                MipLevels: 1,
                                ArraySize: 1,
                                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                                SampleDesc: DXGI_SAMPLE_DESC {
                                    Count: 1,
                                    Quality: 0,
                                },
                                Usage: D3D11_USAGE_DEFAULT,
                                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                                ..Default::default()
                            },
                            None,
                            Some(&mut texture),
                        )
                    }
                    .map_err(|_| Failure::AllocationFailed)?;
                    texture.ok_or(Failure::AllocationFailed)
                })?;
                s.statistics.textures_created += resources.len() as u64;
                s.statistics.pool_sets += 1;
                s.pool = Some(Pool::new(resources, s.generation, s.config));
                s.budget = Some(budget);
                s.layout = Some(layout);
                s.device = Some(device);
            }
            let pool = s.pool.as_mut().unwrap();
            let (index, replaced) = pool.choose(request.event, request.status, now)?;
            // Invalidate the previous logical image before submission. Any copy
            // failure leaves no stale keyframe pointing at partially changed data.
            pool.revoke_slot(index);
            let started = Instant::now();
            {
                let resource = pool.slots[index]
                    .resource
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                source
                    .copy_to(
                        resource
                            .value
                            .as_ref()
                            .ok_or(Failure::ResourceUnavailable)?,
                    )
                    .map_err(|e| {
                        if e == recent_gpu_cache::CacheError::DeviceLost {
                            Failure::DeviceLost
                        } else {
                            Failure::TextureCopyFailed
                        }
                    })?;
            }
            let ms = started.elapsed().as_secs_f64() * 1000.;
            let id = pool.publish(
                index,
                Metadata {
                    id: KeyframeId {
                        generation: 0,
                        sequence: 0,
                    },
                    event: request.event,
                    kind: request.kind,
                    status: request.status,
                    desired_temporal_id: request.sample.id,
                    source: m,
                    detection_confidence: request.detection_confidence,
                    selection_confidence: request.selection_confidence,
                    correlation,
                    correlation_delta: delta,
                },
            );
            let stats = &mut s.statistics;
            stats.succeeded += 1;
            stats.copies += 1;
            stats.replaced += u64::from(replaced);
            stats.average_submission_ms += (ms - stats.average_submission_ms) / stats.copies as f64;
            stats.maximum_submission_ms = stats.maximum_submission_ms.max(ms);
            stats.last_failure = None;
            Ok(id)
        })();
        if let Err(error) = result {
            s.statistics.failure(error);
            if matches!(
                error,
                Failure::AllocationFailed
                    | Failure::InvalidConfiguration
                    | Failure::InsufficientBudget
                    | Failure::DeviceLost
            ) {
                let event_generation = s.event_generation;
                s.clear(event_generation);
                s.failed = true;
            }
        }
        result
    }
    pub fn confirm(
        &self,
        event: EventId,
        kind: KeyframeType,
        confidence: f64,
        now: Instant,
    ) -> Option<KeyframeId> {
        self.lock()
            .pool
            .as_mut()?
            .confirm(event, kind, confidence, now)
    }
    pub fn discard(&self, event: EventId) {
        let mut s = self.lock();
        if s.pool.as_mut().is_some_and(|p| p.discard(event)) {
            s.statistics.discarded += 1;
        }
    }
    pub fn metadata_snapshot(&self, now: Instant) -> Vec<Metadata> {
        self.lock()
            .pool
            .as_ref()
            .map_or_else(Vec::new, |p| p.metadata(now))
    }
    pub fn keyframe(&self, id: KeyframeId, now: Instant) -> Option<KeyframeLease> {
        let s = self.lock();
        let pool = s.pool.as_ref()?;
        let slot = pool.slots.iter().find(|slot| {
            slot.metadata
                .is_some_and(|m| m.id == id && pool.valid(m, now))
        })?;
        Some(KeyframeLease {
            metadata: slot.metadata?,
            resource: slot.resource.clone(),
            retention: s.config.retention,
            turn_reserved: false,
        })
    }
    pub fn reserve_for_turn(&self, id: KeyframeId, until: Instant) -> Option<KeyframeLease> {
        let now = Instant::now();
        if until <= now || until.duration_since(now) > Duration::from_secs(5) {
            return None;
        }
        let s = self.lock();
        let pool = s.pool.as_ref()?;
        // Keep at least two slots free for ongoing stable/transient promotion.
        let limit = pool.slots.len().saturating_sub(2).min(4);
        if pool
            .slots
            .iter()
            .filter(|s| Arc::strong_count(&s.resource) > 1)
            .count()
            >= limit
        {
            return None;
        }
        let slot = pool.slots.iter().find(|slot| {
            slot.metadata.is_some_and(|m| {
                m.id == id && m.status == KeyframeStatus::Confirmed && pool.valid(m, now)
            })
        })?;
        let metadata = slot.metadata?;
        Some(KeyframeLease {
            metadata,
            resource: slot.resource.clone(),
            retention: until.saturating_duration_since(metadata.source.source_timestamp),
            turn_reserved: true,
        })
    }
    pub fn keyframes_for_event(&self, event: EventId, now: Instant) -> Vec<Metadata> {
        self.metadata_snapshot(now)
            .into_iter()
            .filter(|m| m.event == event)
            .collect()
    }
    pub fn preview(&self, id: KeyframeId) -> recent_gpu_cache::Result<PreviewImage> {
        let lease = self
            .keyframe(id, Instant::now())
            .ok_or(recent_gpu_cache::CacheError::Expired)?;
        let image = lease.readback()?;
        if !lease.is_available() {
            return Err(recent_gpu_cache::CacheError::Expired);
        }
        self.lock().statistics.manual_readbacks += 1;
        Ok(image)
    }
    pub fn diagnostics(&self, now: Instant) -> Diagnostics {
        let s = self.lock();
        let metadata = s.pool.as_ref().map_or_else(Vec::new, |p| p.metadata(now));
        let capacity = s.pool.as_ref().map_or(0, |p| p.slots.len());
        let bytes = s.budget.map_or(0, |b| b.bytes_per_frame);
        Diagnostics {
            state: if s.stopped {
                "Stopped"
            } else if s.failed {
                "Unavailable"
            } else if s.pool.is_none() {
                "WaitingForPromotion"
            } else {
                "Running"
            },
            generation: s.generation,
            config: s.config,
            capacity,
            memory_limited_capacity: s.budget.map_or(0, |b| b.memory_limited_capacity),
            provisional: metadata
                .iter()
                .filter(|m| m.status == KeyframeStatus::Provisional)
                .count(),
            confirmed: metadata
                .iter()
                .filter(|m| m.status == KeyframeStatus::Confirmed)
                .count(),
            pinned_slots: s.pool.as_ref().map_or(0, |p| {
                p.slots
                    .iter()
                    .filter(|s| Arc::strong_count(&s.resource) > 1)
                    .count()
            }),
            width: s.layout.map_or(0, |l| l.2),
            height: s.layout.map_or(0, |l| l.3),
            bytes_per_frame: bytes,
            allocated_payload: bytes * capacity as u64,
            occupied_payload: bytes * metadata.len() as u64,
            physical_textures: capacity,
            statistics: s.statistics,
        }
    }
}
