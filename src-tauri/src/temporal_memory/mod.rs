//! Volatile Tier A history. Pixels never implement Debug or Serialize. The
//! analyzer is the sole writer; queries copy metadata or ONE selected image.
use crate::visual_analysis::{Bounds, Classification, Geometry, VisualAnalysisResult};
use serde::Serialize;
use std::{
    mem::size_of,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const HARD_LIMIT: usize = 64 * 1024 * 1024;
fn generation() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

#[derive(Clone, Copy, Debug)]
pub struct TemporalMemoryConfig {
    pub history_duration: Duration,
    pub maximum_sample_rate: u32,
    pub memory_limit_bytes: usize,
}
impl Default for TemporalMemoryConfig {
    fn default() -> Self {
        Self {
            history_duration: Duration::from_secs(5),
            maximum_sample_rate: 60,
            memory_limit_bytes: HARD_LIMIT,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryError {
    InvalidConfiguration,
    AllocationFailed,
    InvalidSample,
    Expired,
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleId {
    pub temporal_generation: u64,
    pub temporal_sequence: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct ChangeSummary {
    pub global_change_score: f64,
    pub changed_area_ratio: f64,
    pub changed_tile_count: u32,
    pub change_bounds: Option<Bounds>,
    pub classification: Classification,
}
#[derive(Clone, Copy, Debug)]
pub struct SampleMetadata {
    pub id: SampleId,
    pub capture_generation: u64,
    pub source_frame_id: u64,
    pub perception_sequence: u64,
    pub analysis_sequence: u64,
    // Source observation time is authoritative for retention and every query.
    // All three are process-local monotonic Instants, never wall-clock strings.
    pub source_timestamp: Instant,
    pub perceived_at: Instant,
    pub analyzed_at: Instant,
    pub geometry: Geometry,
    // Baselines retain None, rather than inventing a NoChange comparison.
    pub change: Option<ChangeSummary>,
}
impl SampleMetadata {
    pub fn from_analysis(
        r: &VisualAnalysisResult,
        source_timestamp: Instant,
        perceived_at: Instant,
        analyzed_at: Instant,
    ) -> Self {
        Self {
            id: SampleId {
                temporal_generation: 0,
                temporal_sequence: 0,
            },
            capture_generation: r.capture_generation,
            source_frame_id: r.source_frame_id,
            perception_sequence: r.perception_sequence,
            analysis_sequence: r.analysis_sequence,
            source_timestamp,
            perceived_at,
            analyzed_at,
            geometry: r.geometry,
            change: r.metrics.as_ref().map(|m| ChangeSummary {
                global_change_score: m.global_change_score,
                changed_area_ratio: m.changed_area_ratio,
                changed_tile_count: m.changed_tile_count,
                change_bounds: m.change_bounds,
                classification: m.classification,
            }),
        }
    }
}
pub struct TemporalVisualSample {
    pub luma: Vec<u8>,
}
impl Drop for TemporalVisualSample {
    fn drop(&mut self) {
        self.luma.fill(0);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub state: &'static str,
    pub history_seconds: f64,
    pub temporal_generation: u64,
    pub temporal_sequence: u64,
    pub capacity: usize,
    pub occupied_slots: usize,
    pub samples: usize,
    pub coverage_seconds: f64,
    pub history_ready: bool,
    pub oldest_age_ms: Option<f64>,
    pub newest_age_ms: Option<f64>,
    pub latest: Option<SampleId>,
    pub analysis_width: u32,
    pub analysis_height: u32,
    pub bytes_per_pixel: usize,
    pub bytes_per_sample: usize,
    pub pixel_memory_bytes: usize,
    pub metadata_memory_bytes: usize,
    pub approximate_memory_bytes: usize,
    pub memory_limit_bytes: usize,
    pub allocation_count: u64,
    pub inserted_samples: u64,
    pub overwrite_count: u64,
    pub temporal_rate: f64,
    pub average_insertion_ms: f64,
    pub maximum_insertion_ms: f64,
    pub error: Option<&'static str>,
}
impl Default for Diagnostics {
    fn default() -> Self {
        Store::new(TemporalMemoryConfig::default(), false).diagnostics(Instant::now())
    }
}

struct Store {
    config: TemporalMemoryConfig,
    enabled: bool,
    generation: u64,
    sequence: u64,
    layout: Option<(u64, Geometry)>,
    slots: Vec<Option<SampleMetadata>>,
    pixels: Vec<u8>,
    bytes_per_sample: usize,
    head: usize,
    occupied: usize,
    allocations: u64,
    inserted: u64,
    overwrites: u64,
    average_ms: f64,
    maximum_ms: f64,
    rate_start: Instant,
    rate_count: u64,
    rate: f64,
    last_insert: Option<Instant>,
    error: Option<&'static str>,
}
impl TemporalMemoryConfig {
    fn budget(self, g: Geometry) -> Result<(usize, usize), MemoryError> {
        let invalid = MemoryError::InvalidConfiguration;
        if self.history_duration.is_zero()
            || self.history_duration > Duration::from_secs(30)
            || self.maximum_sample_rate == 0
            || self.maximum_sample_rate > 60
            || self.memory_limit_bytes == 0
            || self.memory_limit_bytes > HARD_LIMIT
            || g.analysis_width == 0
            || g.analysis_height == 0
            || g.analysis_width > 4096
            || g.analysis_height > 4096
        {
            return Err(invalid);
        }
        // Integer ceil: nominal time * maximum rate, then 10% capacity headroom.
        let nominal = (self.history_duration.as_nanos() * self.maximum_sample_rate as u128)
            .div_ceil(1_000_000_000);
        let capacity = usize::try_from((nominal * 11).div_ceil(10)).map_err(|_| invalid)?;
        let bytes = (g.analysis_width as usize)
            .checked_mul(g.analysis_height as usize)
            .ok_or(invalid)?;
        let total = bytes
            .checked_add(size_of::<Option<SampleMetadata>>())
            .and_then(|n| n.checked_mul(capacity))
            .and_then(|n| n.checked_add(size_of::<Store>()))
            .ok_or(invalid)?;
        if total > self.memory_limit_bytes {
            return Err(invalid);
        }
        Ok((capacity, bytes))
    }
}
impl Store {
    fn new(config: TemporalMemoryConfig, enabled: bool) -> Self {
        Self {
            config,
            enabled,
            generation: if enabled { generation() } else { 0 },
            sequence: 0,
            layout: None,
            slots: Vec::new(),
            pixels: Vec::new(),
            bytes_per_sample: 0,
            head: 0,
            occupied: 0,
            allocations: 0,
            inserted: 0,
            overwrites: 0,
            average_ms: 0.,
            maximum_ms: 0.,
            rate_start: Instant::now(),
            rate_count: 0,
            rate: 0.,
            last_insert: None,
            error: None,
        }
    }
    fn clear(&mut self, release: bool) {
        self.pixels.fill(0);
        self.slots.fill(None);
        self.head = 0;
        self.occupied = 0;
        self.generation = generation();
        self.last_insert = None;
        self.rate = 0.;
        self.rate_start = Instant::now();
        self.rate_count = self.inserted;
        if release {
            self.pixels = Vec::new();
            self.slots = Vec::new();
            self.layout = None;
            self.bytes_per_sample = 0;
        }
    }
    fn prepare(
        &mut self,
        capture: u64,
        geometry: Geometry,
        reset: bool,
    ) -> Result<(), MemoryError> {
        if !self.enabled {
            return Err(MemoryError::Stopped);
        }
        if !reset && self.layout == Some((capture, geometry)) {
            return Ok(());
        }
        // Drop incompatible history before allocation, including on failure.
        let reuse = self.layout.is_some_and(|(_, g)| g == geometry);
        self.clear(!reuse);
        let result = (|| {
            let (capacity, bytes) = self.config.budget(geometry)?;
            if self.slots.len() != capacity || self.bytes_per_sample != bytes {
                self.clear(true);
                self.slots
                    .try_reserve_exact(capacity)
                    .map_err(|_| MemoryError::AllocationFailed)?;
                self.pixels
                    .try_reserve_exact(capacity * bytes)
                    .map_err(|_| MemoryError::AllocationFailed)?;
                self.slots.resize(capacity, None);
                self.pixels.resize(capacity * bytes, 0);
                self.bytes_per_sample = bytes;
                self.allocations += 1;
            }
            self.layout = Some((capture, geometry));
            Ok(())
        })();
        if result.is_err() {
            self.clear(true);
            self.enabled = false;
            self.error =
                Some("Temporal allocation rejected or unavailable. Restart Screen Awareness.");
        }
        result
    }
    fn push(
        &mut self,
        mut m: SampleMetadata,
        pixels: &[u8],
        now: Instant,
    ) -> Result<SampleId, MemoryError> {
        if !self.enabled {
            return Err(MemoryError::Stopped);
        }
        if self.layout != Some((m.capture_generation, m.geometry))
            || pixels.len() != self.bytes_per_sample
            || self.slots.is_empty()
            || m.source_timestamp > m.perceived_at
            || m.perceived_at > m.analyzed_at
            || m.analyzed_at > now
        {
            return Err(MemoryError::InvalidSample);
        }
        if let Some(last) = self.slots[(self.head + self.slots.len() - 1) % self.slots.len()] {
            if m.source_timestamp < last.source_timestamp
                || m.source_frame_id <= last.source_frame_id
                || m.analysis_sequence <= last.analysis_sequence
                || m.perception_sequence <= last.perception_sequence
            {
                return Err(MemoryError::InvalidSample);
            }
        }
        self.sequence += 1;
        m.id = SampleId {
            temporal_generation: self.generation,
            temporal_sequence: self.sequence,
        };
        let start = self.head * self.bytes_per_sample;
        self.pixels[start..start + self.bytes_per_sample].copy_from_slice(pixels);
        self.slots[self.head] = Some(m);
        self.head = (self.head + 1) % self.slots.len();
        if self.occupied == self.slots.len() {
            self.overwrites += 1;
        } else {
            self.occupied += 1;
        }
        self.inserted += 1;
        self.last_insert = Some(now);
        let elapsed = now.saturating_duration_since(self.rate_start).as_secs_f64();
        if elapsed >= 1. {
            self.rate = (self.inserted - self.rate_count) as f64 / elapsed;
            self.rate_start = now;
            self.rate_count = self.inserted;
        }
        Ok(m.id)
    }
    fn valid(&self, m: &SampleMetadata, now: Instant) -> bool {
        self.enabled
            && m.id.temporal_generation == self.generation
            && m.source_timestamp <= now
            && now.duration_since(m.source_timestamp) <= self.config.history_duration
    }
    fn iter(&self, now: Instant) -> impl DoubleEndedIterator<Item = &SampleMetadata> {
        let capacity = self.slots.len();
        (0..self.occupied)
            .filter_map(move |i| {
                self.slots[(self.head + capacity - self.occupied + i) % capacity].as_ref()
            })
            .filter(move |m| self.valid(m, now))
    }
    fn lookup(&self, id: SampleId, now: Instant) -> Option<(usize, SampleMetadata)> {
        if id.temporal_generation != self.generation || id.temporal_sequence > self.sequence {
            return None;
        }
        let distance = usize::try_from(self.sequence - id.temporal_sequence).ok()?;
        if distance >= self.occupied {
            return None;
        }
        let index = (self.head + self.slots.len() - 1 - distance) % self.slots.len();
        let m = self.slots[index]?;
        (m.id == id && self.valid(&m, now)).then_some((index, m))
    }
    fn diagnostics(&self, now: Instant) -> Diagnostics {
        let oldest = self.iter(now).next();
        let newest = self.iter(now).next_back();
        let coverage = oldest.zip(newest).map_or(0., |(a, b)| {
            b.source_timestamp
                .duration_since(a.source_timestamp)
                .as_secs_f64()
        });
        let pixel_memory = self.pixels.capacity();
        let metadata_memory = self.slots.capacity() * size_of::<Option<SampleMetadata>>();
        let geometry = self.layout.map(|(_, g)| g);
        Diagnostics {
            state: if self.error.is_some() {
                "Failed"
            } else if !self.enabled {
                "Stopped / Cleared"
            } else if self.layout.is_none() {
                "WaitingForFrame"
            } else {
                "Running"
            },
            history_seconds: self.config.history_duration.as_secs_f64(),
            temporal_generation: self.generation,
            temporal_sequence: self.sequence,
            capacity: self.slots.len(),
            occupied_slots: self.occupied,
            samples: self.iter(now).count(),
            coverage_seconds: coverage,
            history_ready: coverage >= self.config.history_duration.as_secs_f64() * 0.95,
            oldest_age_ms: oldest
                .map(|m| now.duration_since(m.source_timestamp).as_secs_f64() * 1000.),
            newest_age_ms: newest
                .map(|m| now.duration_since(m.source_timestamp).as_secs_f64() * 1000.),
            latest: newest.map(|m| m.id),
            analysis_width: geometry.map_or(0, |g| g.analysis_width),
            analysis_height: geometry.map_or(0, |g| g.analysis_height),
            bytes_per_pixel: 1,
            bytes_per_sample: self.bytes_per_sample,
            pixel_memory_bytes: pixel_memory,
            metadata_memory_bytes: metadata_memory,
            approximate_memory_bytes: pixel_memory + metadata_memory + size_of::<Store>(),
            memory_limit_bytes: self.config.memory_limit_bytes,
            allocation_count: self.allocations,
            inserted_samples: self.inserted,
            overwrite_count: self.overwrites,
            temporal_rate: if self
                .last_insert
                .is_some_and(|t| now.saturating_duration_since(t) < Duration::from_secs(2))
            {
                self.rate
            } else {
                0.
            },
            average_insertion_ms: self.average_ms,
            maximum_insertion_ms: self.maximum_ms,
            error: self.error,
        }
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        self.pixels.fill(0);
    }
}

#[derive(Clone)]
pub struct TemporalMemory(Arc<Mutex<Store>>);
impl TemporalMemory {
    pub fn generation(&self) -> u64 {
        self.lock().generation
    }
    pub fn new(config: TemporalMemoryConfig) -> Self {
        Self(Arc::new(Mutex::new(Store::new(config, true))))
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Store> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(crate) fn prepare(
        &self,
        capture: u64,
        g: Geometry,
        reset: bool,
    ) -> Result<(), MemoryError> {
        self.lock().prepare(capture, g, reset)
    }
    pub(crate) fn push(
        &self,
        m: SampleMetadata,
        pixels: &[u8],
        now: Instant,
    ) -> Result<SampleId, MemoryError> {
        let started = Instant::now();
        let mut store = self.lock();
        let result = store.push(m, pixels, now);
        if result.is_ok() {
            let ms = started.elapsed().as_secs_f64() * 1000.;
            store.average_ms += (ms - store.average_ms) / store.inserted as f64;
            store.maximum_ms = store.maximum_ms.max(ms);
        }
        result
    }
    // Terminal revocation: even a retained reader handle cannot restart writes.
    pub fn stop(&self) {
        let mut s = self.lock();
        if s.enabled || !s.pixels.is_empty() {
            s.enabled = false;
            s.clear(true);
        }
    }
    pub fn diagnostics(&self, now: Instant) -> Diagnostics {
        self.lock().diagnostics(now)
    }
    pub fn samples_between(
        &self,
        start: Instant,
        end: Instant,
        now: Instant,
    ) -> Vec<SampleMetadata> {
        self.lock()
            .iter(now)
            .filter(|m| m.source_timestamp >= start && m.source_timestamp <= end)
            .copied()
            .collect()
    }
    pub fn nearest_to(&self, target: Instant, now: Instant) -> Option<SampleMetadata> {
        // Ties choose the older sample. Targets outside history clamp to an end.
        self.lock()
            .iter(now)
            .min_by_key(|m| {
                if m.source_timestamp >= target {
                    m.source_timestamp - target
                } else {
                    target - m.source_timestamp
                }
            })
            .copied()
    }
    pub fn sample_ago(&self, age: Duration, now: Instant) -> Option<SampleMetadata> {
        self.nearest_to(now.checked_sub(age)?, now)
    }
    pub fn metadata_for(&self, id: SampleId, now: Instant) -> Result<SampleMetadata, MemoryError> {
        self.lock()
            .lookup(id, now)
            .map(|(_, m)| m)
            .ok_or(MemoryError::Expired)
    }
    pub fn visual_for(
        &self,
        id: SampleId,
        now: Instant,
    ) -> Result<TemporalVisualSample, MemoryError> {
        let s = self.lock();
        let (index, _) = s.lookup(id, now).ok_or(MemoryError::Expired)?;
        let start = index * s.bytes_per_sample;
        Ok(TemporalVisualSample {
            luma: s.pixels[start..start + s.bytes_per_sample].to_vec(),
        })
    }
    // A read-only bounded comparison, with no pixel ownership or allocation.
    // Both identities are checked while holding one ring lock so reuse cannot
    // substitute a different baseline. The callback must not re-enter the ring.
    pub(crate) fn with_luma_pair<T>(
        &self,
        current: SampleId,
        baseline: Option<SampleId>,
        now: Instant,
        compare: impl FnOnce(SampleMetadata, &[u8], Option<&[u8]>) -> T,
    ) -> Result<T, MemoryError> {
        let s = self.lock();
        let (index, metadata) = s.lookup(current, now).ok_or(MemoryError::Expired)?;
        let pixels = |index: usize| {
            let start = index * s.bytes_per_sample;
            &s.pixels[start..start + s.bytes_per_sample]
        };
        let baseline = baseline
            .and_then(|id| s.lookup(id, now))
            .map(|(index, _)| pixels(index));
        Ok(compare(metadata, pixels(index), baseline))
    }
}
