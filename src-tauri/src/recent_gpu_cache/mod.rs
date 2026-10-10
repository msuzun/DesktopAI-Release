//! Tier B retains a few immutable, application-owned WGC textures. No texture
//! allocation, GPU copy, or readback on admission. Native leases pin replacement
//! and are revoked on reset/stop; no raw texture/Arc escapes this API.
use crate::{perception::PerceptionFrame, platform::screen_capture::wgc::frame::GpuFrameHandle};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use windows::{
    core::Interface,
    Win32::Graphics::{Direct3D11::*, Dxgi::Common::*},
};
pub(crate) mod gpu;
pub const DEFAULT_BUDGET: u64 = 128 * 1024 * 1024;
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub desired_capacity: usize,
    pub minimum_capacity: usize,
    pub memory_budget_bytes: u64,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            desired_capacity: 4,
            minimum_capacity: 2,
            memory_budget_bytes: DEFAULT_BUDGET,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum CacheError {
    InvalidConfiguration,
    InsufficientGpuCacheBudget,
    UnsupportedFormat,
    InvalidSource,
    DeviceLost,
    AllocationFailed,
    Expired,
    Busy,
    IncompatibleDevice,
    ReadbackFailed,
    ReadbackTimeout,
}
pub type Result<T> = std::result::Result<T, CacheError>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    pub bytes_per_frame: u64,
    pub usable_budget: u64,
    pub capacity: usize,
    pub capacity_payload: u64,
}
impl Config {
    pub fn budget(self, width: u32, height: u32, format: DXGI_FORMAT) -> Result<Budget> {
        if self.minimum_capacity < 2
            || self.desired_capacity < self.minimum_capacity
            || self.desired_capacity > 4
            || self.memory_budget_bytes == 0
            || self.memory_budget_bytes > DEFAULT_BUDGET
        {
            return Err(CacheError::InvalidConfiguration);
        }
        if format != DXGI_FORMAT_B8G8R8A8_UNORM {
            return Err(CacheError::UnsupportedFormat);
        }
        let bytes = (width as u64)
            .checked_mul(height as u64)
            .and_then(|n| n.checked_mul(4))
            .ok_or(CacheError::InvalidConfiguration)?;
        if bytes == 0 || width > 16384 || height > 16384 {
            return Err(CacheError::InvalidConfiguration);
        }
        // Dedicated GPU budget; reserve 10% for unknown driver overhead. Payload
        // is still only an estimate, not a physical VRAM measurement.
        let usable = self
            .memory_budget_bytes
            .checked_mul(9)
            .ok_or(CacheError::InvalidConfiguration)?
            / 10;
        let capacity = self.desired_capacity.min((usable / bytes) as usize);
        if capacity < self.minimum_capacity {
            return Err(CacheError::InsufficientGpuCacheBudget);
        }
        Ok(Budget {
            bytes_per_frame: bytes,
            usable_budget: usable,
            capacity,
            capacity_payload: bytes
                .checked_mul(capacity as u64)
                .ok_or(CacheError::InvalidConfiguration)?,
        })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameId {
    pub cache_generation: u64,
    pub cache_sequence: u64,
}
#[derive(Clone, Copy, Debug)]
pub struct Metadata {
    pub id: FrameId,
    pub capture_generation: u64,
    pub source_frame_id: u64,
    pub perception_sequence: u64,
    pub analysis_sequence: u64,
    pub source_timestamp: Instant,
    pub cached_at: Instant,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Copy, Debug)]
pub struct CorrelationTarget {
    pub capture_generation: u64,
    pub source_frame_id: Option<u64>,
    pub perception_sequence: Option<u64>,
    pub source_timestamp: Instant,
}
impl From<crate::temporal_memory::SampleMetadata> for CorrelationTarget {
    fn from(m: crate::temporal_memory::SampleMetadata) -> Self {
        Self {
            capture_generation: m.capture_generation,
            source_frame_id: Some(m.source_frame_id),
            perception_sequence: Some(m.perception_sequence),
            source_timestamp: m.source_timestamp,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum MatchKind {
    ExactSource,
    ExactPerception,
    NearestTimestamp,
}
pub struct Match {
    pub frame: FrameLease,
    pub delta: Duration,
    pub kind: MatchKind,
}

// A lease owns this revocable cell, never the underlying GpuFrameHandle. The
// producer's immutable texture survives normal WGC/perception replacement. A
// cache reset takes the cell's frame even if a caller keeps the lease forever.
struct FrameCell {
    frame: Mutex<Option<Arc<GpuFrameHandle>>>,
    counters: Arc<Counters>,
}
#[derive(Clone)]
pub struct FrameLease {
    metadata: Metadata,
    cell: Arc<FrameCell>,
}
impl FrameLease {
    pub fn metadata(&self) -> Metadata {
        self.metadata
    }
    pub fn is_available(&self) -> bool {
        self.cell
            .frame
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }
}
struct Slot {
    metadata: Option<Metadata>,
    cell: Arc<FrameCell>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum State {
    Stopped,
    WaitingForFrame,
    Running,
    Reconfiguring,
    Failed,
}
#[derive(Default)]
struct Counters {
    attempts: AtomicU64,
    dropped: AtomicU64,
    total_ns: AtomicU64,
    maximum_ns: AtomicU64,
    manual_readbacks: AtomicU64,
    consumer_copies: AtomicU64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub state: State,
    pub config: Config,
    pub cache_generation: u64,
    pub cache_sequence: u64,
    pub width: u32,
    pub height: u32,
    pub pixel_format: &'static str,
    pub entries: usize,
    pub capacity: usize,
    pub pinned_slots: usize,
    pub estimated_bytes_per_texture: u64,
    pub estimated_retained_payload: u64,
    pub capacity_payload: u64,
    pub usable_payload_budget: u64,
    pub oldest_age_ms: Option<f64>,
    pub newest_age_ms: Option<f64>,
    pub coverage_ms: f64,
    pub insertion_attempts: u64,
    pub successful_insertions: u64,
    pub dropped_insertions: u64,
    pub slot_reuse_count: u64,
    pub cache_wrap_count: u64,
    pub cache_resets: u64,
    pub slot_sets_created: u64,
    pub owned_texture_creations: u64,
    pub gpu_copies_issued: u64,
    pub manual_readbacks: u64,
    pub consumer_copies: u64,
    pub insertion_rate: f64,
    pub average_insertion_cpu_ms: f64,
    pub maximum_insertion_cpu_ms: f64,
    pub error: Option<CacheError>,
}
impl Default for Diagnostics {
    fn default() -> Self {
        RecentGpuFrameCache::stopped().diagnostics(Instant::now())
    }
}
struct Store {
    config: Config,
    state: State,
    generation: u64,
    sequence: u64,
    slots: Vec<Slot>,
    head: usize,
    len: usize,
    // COM device identity is compared while `device` owns that object.
    layout: Option<(u64, u32, u32, i32)>,
    device: Option<ID3D11Device>,
    budget: Option<Budget>,
    admitted: u64,
    reused: u64,
    wraps: u64,
    resets: u64,
    slot_sets: u64,
    error: Option<CacheError>,
    rate_start: Instant,
    rate_count: u64,
    rate: f64,
    last_insert: Option<Instant>,
}
fn generation() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}
impl Store {
    fn new(config: Config, state: State) -> Self {
        Self {
            config,
            state,
            generation: if state == State::Stopped {
                0
            } else {
                generation()
            },
            sequence: 0,
            slots: Vec::new(),
            head: 0,
            len: 0,
            layout: None,
            device: None,
            budget: None,
            admitted: 0,
            reused: 0,
            wraps: 0,
            resets: 0,
            slot_sets: 0,
            error: None,
            rate_start: Instant::now(),
            rate_count: 0,
            rate: 0.,
            last_insert: None,
        }
    }
    fn revoke(&mut self) {
        for slot in &self.slots {
            slot.cell
                .frame
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
        }
        self.slots.clear();
        self.slots.shrink_to_fit();
        self.head = 0;
        self.len = 0;
        self.device = None;
        self.layout = None;
        self.budget = None;
        self.sequence = 0;
        self.generation = generation();
        self.rate = 0.;
        self.last_insert = None;
        self.rate_start = Instant::now();
        self.rate_count = self.admitted;
        self.resets += 1;
    }
    fn iter(&self) -> impl DoubleEndedIterator<Item = (usize, &Metadata)> {
        (0..self.len).filter_map(move |i| {
            let index = (self.head + self.slots.len() - self.len + i) % self.slots.len();
            self.slots[index].metadata.as_ref().map(|m| (index, m))
        })
    }
    fn lease(&self, index: usize) -> FrameLease {
        FrameLease {
            metadata: self.slots[index].metadata.unwrap(),
            cell: self.slots[index].cell.clone(),
        }
    }
    fn fail(&mut self, error: CacheError) {
        self.revoke();
        self.error = Some(error);
        self.state = State::Failed;
    }
    fn publish(&mut self, mut metadata: Metadata, frame: Option<Arc<GpuFrameHandle>>) -> bool {
        if !AdmitNewAnalyzed::accepts(self.iter().next_back().map(|(_, m)| m), &metadata) {
            return false;
        }
        let index = self.head;
        if Arc::strong_count(&self.slots[index].cell) != 1 {
            return false;
        }
        self.sequence += 1;
        metadata.id = FrameId {
            cache_generation: self.generation,
            cache_sequence: self.sequence,
        };
        let slot = &mut self.slots[index];
        {
            let mut resource = slot.cell.frame.lock().unwrap_or_else(|e| e.into_inner());
            resource.take();
            *resource = frame;
        }
        slot.metadata = Some(metadata);
        if self.len == self.slots.len() {
            self.reused += 1;
        } else {
            self.len += 1;
        }
        self.head = (index + 1) % self.slots.len();
        if self.head == 0 {
            self.wraps += 1;
        }
        self.admitted += 1;
        self.last_insert = Some(metadata.cached_at);
        let elapsed = metadata
            .cached_at
            .saturating_duration_since(self.rate_start)
            .as_secs_f64();
        if elapsed >= 1. {
            self.rate = (self.admitted - self.rate_count) as f64 / elapsed;
            self.rate_count = self.admitted;
            self.rate_start = metadata.cached_at;
        }
        true
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        self.revoke();
    }
}
#[derive(Clone)]
pub struct RecentGpuFrameCache {
    shared: Arc<Mutex<Store>>,
    counters: Arc<Counters>,
    changed: Arc<Condvar>,
}
// Admission policy is deliberately separate from storage and correlation.
struct AdmitNewAnalyzed;
impl AdmitNewAnalyzed {
    fn accepts(last: Option<&Metadata>, frame: &Metadata) -> bool {
        last.is_none_or(|m| {
            frame.source_frame_id > m.source_frame_id
                && frame.perception_sequence > m.perception_sequence
                && frame.analysis_sequence > m.analysis_sequence
                && frame.source_timestamp >= m.source_timestamp
        })
    }
}
impl RecentGpuFrameCache {
    pub fn new(config: Config) -> Self {
        Self {
            shared: Arc::new(Mutex::new(Store::new(config, State::WaitingForFrame))),
            counters: Arc::new(Counters::default()),
            changed: Arc::new(Condvar::new()),
        }
    }
    fn stopped() -> Self {
        Self {
            shared: Arc::new(Mutex::new(Store::new(Config::default(), State::Stopped))),
            counters: Arc::new(Counters::default()),
            changed: Arc::new(Condvar::new()),
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Store> {
        self.shared.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn stop(&self) {
        let mut s = self.lock();
        if s.state != State::Stopped {
            s.revoke();
            s.state = State::Stopped;
            self.changed.notify_all();
        }
    }
    pub fn clear(&self) {
        let mut s = self.lock();
        if s.state != State::Stopped {
            s.revoke();
            s.state = State::WaitingForFrame;
            s.error = None;
            self.changed.notify_all();
        }
    }
    pub(crate) fn insert(&self, frame: &PerceptionFrame<GpuFrameHandle>, analysis: u64) -> bool {
        let started = Instant::now();
        self.counters.attempts.fetch_add(1, Ordering::Relaxed);
        let accepted = self.try_insert(frame, analysis);
        if accepted {
            self.changed.notify_all();
        }
        if !accepted {
            self.counters.dropped.fetch_add(1, Ordering::Relaxed);
        }
        let nanos = started.elapsed().as_nanos().min(u64::MAX as u128) as u64;
        self.counters.total_ns.fetch_add(nanos, Ordering::Relaxed);
        self.counters.maximum_ns.fetch_max(nanos, Ordering::Relaxed);
        accepted
    }
    fn try_insert(&self, frame: &PerceptionFrame<GpuFrameHandle>, analysis: u64) -> bool {
        let Ok(mut s) = self.shared.try_lock() else {
            return false;
        };
        if matches!(s.state, State::Stopped | State::Failed) {
            return false;
        }
        let f = &frame.gpu_frame_handle;
        let device = match gpu::validate(f) {
            Ok(d) => d,
            Err(e) => {
                s.fail(e);
                return false;
            }
        };
        if frame.source.capture_generation != f.capture_generation
            || frame.source.frame_id != f.frame_id
            || frame.source.source_timestamp != f.captured_at
            || frame.source.width != f.width
            || frame.source.height != f.height
            || frame.source.pixel_format != "BGRA8_UNORM"
            || frame.source.source_timestamp > frame.perceived_at
        {
            s.fail(CacheError::InvalidSource);
            return false;
        }
        if s.layout.is_some_and(|l| f.capture_generation < l.0) {
            return false;
        }
        let layout = (f.capture_generation, f.width, f.height, f.pixel_format.0);
        if s.layout != Some(layout) || s.device.as_ref() != Some(&device) {
            s.state = State::Reconfiguring;
            s.revoke();
            let budget = match s.config.budget(f.width, f.height, f.pixel_format) {
                Ok(b) => b,
                Err(e) => {
                    s.fail(e);
                    return false;
                }
            };
            let mut slots = Vec::new();
            if slots.try_reserve_exact(budget.capacity).is_err() {
                s.fail(CacheError::AllocationFailed);
                return false;
            }
            for _ in 0..budget.capacity {
                slots.push(Slot {
                    metadata: None,
                    cell: Arc::new(FrameCell {
                        frame: Mutex::new(None),
                        counters: self.counters.clone(),
                    }),
                });
            }
            s.slots = slots;
            s.layout = Some(layout);
            s.device = Some(device);
            s.budget = Some(budget);
            s.slot_sets += 1;
            s.state = State::Running;
            s.error = None;
        }
        let index = s.head;
        // Cache owns exactly one cell Arc. Any lease pins this replacement slot.
        // Drop instead of changing order, waiting, or creating overflow storage.
        if Arc::strong_count(&s.slots[index].cell) != 1 {
            return false;
        }
        let now = Instant::now();
        let metadata = Metadata {
            id: FrameId {
                cache_generation: s.generation,
                cache_sequence: s.sequence,
            },
            capture_generation: f.capture_generation,
            source_frame_id: f.frame_id,
            perception_sequence: frame.perception_sequence,
            analysis_sequence: analysis,
            source_timestamp: f.captured_at,
            cached_at: now,
            width: f.width,
            height: f.height,
        };
        // Drop old cache ownership BEFORE retaining the next immutable texture.
        // The producer already made the necessary WGC -> owned GPU copy.
        s.publish(metadata, Some(f.clone()))
    }
    pub fn latest(&self) -> Option<FrameLease> {
        let s = self.lock();
        let result = s.iter().next_back().map(|(i, _)| s.lease(i));
        result
    }
    pub fn generation(&self) -> u64 {
        self.lock().generation
    }
    /// Wait on publication/reset, never on a polling loop. The caller owns the
    /// overall deadline and revalidates its permission/turn after waking.
    pub fn wait_for_newer(&self, after: Option<FrameId>, deadline: Instant) -> Option<FrameLease> {
        let mut s = self.lock();
        loop {
            if matches!(s.state, State::Stopped | State::Failed) {
                return None;
            }
            if let Some((index, metadata)) = s.iter().next_back() {
                if Some(metadata.id) != after {
                    return Some(s.lease(index));
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            s = self
                .changed
                .wait_timeout(s, remaining)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
    pub fn oldest(&self) -> Option<FrameLease> {
        let s = self.lock();
        let result = s.iter().next().map(|(i, _)| s.lease(i));
        result
    }
    pub fn get(&self, id: FrameId) -> Result<FrameLease> {
        let s = self.lock();
        let result = s
            .iter()
            .find(|(_, m)| m.id == id)
            .map(|(i, _)| s.lease(i))
            .ok_or(CacheError::Expired);
        result
    }
    pub fn recent_entries(&self) -> Vec<Metadata> {
        self.lock().iter().map(|(_, m)| *m).collect()
    }
    pub fn nearest_to(
        &self,
        capture_generation: u64,
        target: Instant,
        maximum_distance: Duration,
    ) -> Option<Match> {
        self.correlate(
            CorrelationTarget {
                capture_generation,
                source_frame_id: None,
                perception_sequence: None,
                source_timestamp: target,
            },
            maximum_distance,
        )
    }
    pub fn correlate(
        &self,
        target: CorrelationTarget,
        maximum_distance: Duration,
    ) -> Option<Match> {
        let s = self.lock();
        let eligible = |m: &&Metadata| m.capture_generation == target.capture_generation;
        let exact = s
            .iter()
            .filter(|(_, m)| eligible(m))
            .find(|(_, m)| Some(m.source_frame_id) == target.source_frame_id)
            .map(|(i, m)| (i, m, MatchKind::ExactSource));
        let perception = || {
            s.iter()
                .filter(|(_, m)| eligible(m))
                .find(|(_, m)| Some(m.perception_sequence) == target.perception_sequence)
                .map(|(i, m)| (i, m, MatchKind::ExactPerception))
        };
        // Iterate newest first so equal-distance ties choose the newer frame.
        let nearest = || {
            s.iter()
                .rev()
                .filter(|(_, m)| eligible(m))
                .min_by_key(|(_, m)| distance(m.source_timestamp, target.source_timestamp))
                .map(|(i, m)| (i, m, MatchKind::NearestTimestamp))
        };
        let (i, m, kind) = exact.or_else(perception).or_else(nearest)?;
        let delta = distance(m.source_timestamp, target.source_timestamp);
        (delta <= maximum_distance).then(|| Match {
            frame: s.lease(i),
            delta,
            kind,
        })
    }
    pub fn diagnostics(&self, now: Instant) -> Diagnostics {
        let s = self.lock();
        let first = s.iter().next().map(|(_, m)| m);
        let last = s.iter().next_back().map(|(_, m)| m);
        let attempts = self.counters.attempts.load(Ordering::Relaxed);
        let budget = s.budget;
        Diagnostics {
            state: s.state,
            config: s.config,
            cache_generation: s.generation,
            cache_sequence: s.sequence,
            width: s.layout.map_or(0, |l| l.1),
            height: s.layout.map_or(0, |l| l.2),
            pixel_format: "BGRA8_UNORM",
            entries: s.len,
            capacity: s.slots.len(),
            pinned_slots: s
                .slots
                .iter()
                .filter(|slot| Arc::strong_count(&slot.cell) > 1)
                .count(),
            estimated_bytes_per_texture: budget.map_or(0, |b| b.bytes_per_frame),
            estimated_retained_payload: budget.map_or(0, |b| b.bytes_per_frame * s.len as u64),
            capacity_payload: budget.map_or(0, |b| b.capacity_payload),
            usable_payload_budget: s.config.memory_budget_bytes.saturating_mul(9) / 10,
            oldest_age_ms: first.map(|m| {
                now.saturating_duration_since(m.source_timestamp)
                    .as_secs_f64()
                    * 1000.
            }),
            newest_age_ms: last.map(|m| {
                now.saturating_duration_since(m.source_timestamp)
                    .as_secs_f64()
                    * 1000.
            }),
            coverage_ms: first.zip(last).map_or(0., |(a, b)| {
                b.source_timestamp
                    .saturating_duration_since(a.source_timestamp)
                    .as_secs_f64()
                    * 1000.
            }),
            insertion_attempts: attempts,
            successful_insertions: s.admitted,
            dropped_insertions: self.counters.dropped.load(Ordering::Relaxed),
            slot_reuse_count: s.reused,
            cache_wrap_count: s.wraps,
            cache_resets: s.resets,
            slot_sets_created: s.slot_sets,
            owned_texture_creations: 0,
            gpu_copies_issued: 0,
            manual_readbacks: self.counters.manual_readbacks.load(Ordering::Relaxed),
            consumer_copies: self.counters.consumer_copies.load(Ordering::Relaxed),
            insertion_rate: if s
                .last_insert
                .is_some_and(|t| now.saturating_duration_since(t) < Duration::from_secs(2))
            {
                s.rate
            } else {
                0.
            },
            average_insertion_cpu_ms: if attempts == 0 {
                0.
            } else {
                self.counters.total_ns.load(Ordering::Relaxed) as f64 / attempts as f64 / 1e6
            },
            maximum_insertion_cpu_ms: self.counters.maximum_ns.load(Ordering::Relaxed) as f64 / 1e6,
            error: s.error,
        }
    }
}
fn distance(a: Instant, b: Instant) -> Duration {
    if a >= b {
        a - b
    } else {
        b - a
    }
}
