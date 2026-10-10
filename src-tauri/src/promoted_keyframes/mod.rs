//! Tier C: a fixed independently owned GPU texture pool, sparse event selection.
mod gpu;
use crate::{
    recent_gpu_cache::{MatchKind, Metadata as SourceMetadata},
    temporal_memory::SampleId,
    visual_events::{EventId, KeyframeId, KeyframeStatus, KeyframeType},
};
pub use gpu::{KeyframeLease, PromotedKeyframeCache};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub desired_capacity: usize,
    pub memory_budget_bytes: u64,
    pub provisional_limit: usize,
    pub retention: Duration,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            desired_capacity: 6,
            memory_budget_bytes: 128 * 1024 * 1024,
            provisional_limit: 1,
            retention: Duration::from_secs(5),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Failure {
    InvalidConfiguration,
    InsufficientBudget,
    AllocationFailed,
    NoTierBMatch,
    TemporalDeltaTooLarge,
    TierCCapacity,
    TextureCopyFailed,
    GenerationMismatch,
    ResourceUnavailable,
    DeviceLost,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    pub bytes_per_frame: u64,
    pub capacity: usize,
    pub memory_limited_capacity: usize,
    pub usable: u64,
    pub payload: u64,
}
impl Config {
    pub fn budget(self, width: u32, height: u32) -> Result<Budget, Failure> {
        if !(1..=8).contains(&self.desired_capacity)
            || self.provisional_limit != 1
            || self.memory_budget_bytes == 0
            || self.memory_budget_bytes > 128 * 1024 * 1024
            || self.retention.is_zero()
            || self.retention > Duration::from_secs(5)
        {
            return Err(Failure::InvalidConfiguration);
        }
        let bytes = (width as u64)
            .checked_mul(height as u64)
            .and_then(|n| n.checked_mul(4))
            .ok_or(Failure::InvalidConfiguration)?;
        if bytes == 0 || width > 16384 || height > 16384 {
            return Err(Failure::InvalidConfiguration);
        }
        let usable = self
            .memory_budget_bytes
            .checked_mul(9)
            .ok_or(Failure::InvalidConfiguration)?
            / 10;
        let capacity = self.desired_capacity.min((usable / bytes) as usize);
        if capacity == 0 {
            return Err(Failure::InsufficientBudget);
        }
        Ok(Budget {
            bytes_per_frame: bytes,
            capacity,
            memory_limited_capacity: (usable / bytes) as usize,
            usable,
            payload: bytes
                .checked_mul(capacity as u64)
                .ok_or(Failure::InvalidConfiguration)?,
        })
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Metadata {
    pub id: KeyframeId,
    pub event: EventId,
    pub kind: KeyframeType,
    pub status: KeyframeStatus,
    pub desired_temporal_id: SampleId,
    pub source: SourceMetadata,
    pub detection_confidence: f64,
    pub selection_confidence: f64,
    pub correlation: MatchKind,
    pub correlation_delta: Duration,
}
struct Resource<R> {
    value: Option<R>,
    id: Option<KeyframeId>,
    queryable: bool,
}
struct Slot<R> {
    metadata: Option<Metadata>,
    resource: Arc<Mutex<Resource<R>>>,
}
struct Pool<R> {
    slots: Vec<Slot<R>>,
    generation: u64,
    sequence: u64,
    retention: Duration,
    provisional_limit: usize,
}
// Bounded, single-pass allocation fallback: keep a usable partial pool. No retry
// loop, overflow textures, or resource allocation on subsequent promotions.
fn allocate_up_to<R>(
    capacity: usize,
    mut allocate: impl FnMut() -> Result<R, Failure>,
) -> Result<Vec<R>, Failure> {
    let mut resources = Vec::new();
    resources
        .try_reserve_exact(capacity)
        .map_err(|_| Failure::AllocationFailed)?;
    for _ in 0..capacity {
        match allocate() {
            Ok(resource) => resources.push(resource),
            Err(error) if resources.is_empty() => return Err(error),
            Err(_) => break,
        }
    }
    Ok(resources)
}
impl<R> Pool<R> {
    fn new(resources: Vec<R>, generation: u64, config: Config) -> Self {
        Self {
            slots: resources
                .into_iter()
                .map(|r| Slot {
                    metadata: None,
                    resource: Arc::new(Mutex::new(Resource {
                        value: Some(r),
                        id: None,
                        queryable: false,
                    })),
                })
                .collect(),
            generation,
            sequence: 0,
            retention: config.retention,
            provisional_limit: config.provisional_limit,
        }
    }
    fn revoke_slot(&mut self, index: usize) {
        self.slots[index].metadata = None;
        self.slots[index]
            .resource
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .id = None;
    }
    fn prune(&mut self, now: Instant) {
        for i in 0..self.slots.len() {
            if self.slots[i].metadata.is_some_and(|m| {
                now.saturating_duration_since(m.source.source_timestamp) > self.retention
            }) {
                self.slots[i]
                    .resource
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .queryable = false;
                // Expire from normal queries immediately. A bounded context lease
                // may still own this existing slot; never overwrite it while held.
                if Arc::strong_count(&self.slots[i].resource) == 1 {
                    self.revoke_slot(i);
                } else {
                    self.slots[i].metadata = None;
                }
            }
        }
    }
    fn valid(&self, m: Metadata, now: Instant) -> bool {
        m.id.generation == self.generation
            && m.source.source_timestamp <= now
            && now.duration_since(m.source.source_timestamp) <= self.retention
    }
    fn metadata(&self, now: Instant) -> Vec<Metadata> {
        let mut result = self
            .slots
            .iter()
            .filter_map(|s| s.metadata)
            .filter(|m| self.valid(*m, now))
            .collect::<Vec<_>>();
        result.sort_by_key(|m| m.source.source_timestamp);
        result
    }
    fn choose(
        &mut self,
        event: EventId,
        status: KeyframeStatus,
        now: Instant,
    ) -> Result<(usize, bool), Failure> {
        self.prune(now);
        if let Some(i) = self
            .slots
            .iter()
            .position(|s| s.metadata.is_some_and(|m| m.event == event))
        {
            let s = &self.slots[i];
            if s.metadata.unwrap().status == KeyframeStatus::Confirmed
                || Arc::strong_count(&s.resource) != 1
            {
                return Err(Failure::TierCCapacity);
            }
            return Ok((i, true));
        }
        if status == KeyframeStatus::Provisional
            && self
                .slots
                .iter()
                .filter(|s| {
                    s.metadata
                        .is_some_and(|m| m.status == KeyframeStatus::Provisional)
                })
                .count()
                >= self.provisional_limit
        {
            return Err(Failure::TierCCapacity);
        }
        if let Some(i) = self
            .slots
            .iter()
            .position(|s| s.metadata.is_none() && Arc::strong_count(&s.resource) == 1)
        {
            return Ok((i, false));
        }
        self.slots
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                Arc::strong_count(&s.resource) == 1
                    && s.metadata
                        .is_some_and(|m| m.status == KeyframeStatus::Confirmed)
            })
            .min_by_key(|(_, s)| {
                let m = s.metadata.unwrap();
                (m.detection_confidence >= 0.75, m.source.source_timestamp)
            })
            .map(|(i, _)| (i, false))
            .ok_or(Failure::TierCCapacity)
    }
    fn publish(&mut self, index: usize, mut metadata: Metadata) -> KeyframeId {
        self.sequence += 1;
        metadata.id = KeyframeId {
            generation: self.generation,
            sequence: self.sequence,
        };
        {
            let mut resource = self.slots[index]
                .resource
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            resource.id = Some(metadata.id);
            resource.queryable = true;
        }
        self.slots[index].metadata = Some(metadata);
        metadata.id
    }
    fn confirm(
        &mut self,
        event: EventId,
        kind: KeyframeType,
        confidence: f64,
        now: Instant,
    ) -> Option<KeyframeId> {
        self.prune(now);
        let m = self
            .slots
            .iter_mut()
            .filter_map(|s| s.metadata.as_mut())
            .find(|m| m.event == event)?;
        m.status = KeyframeStatus::Confirmed;
        m.kind = kind;
        m.detection_confidence = confidence;
        Some(m.id)
    }
    fn discard(&mut self, event: EventId) -> bool {
        if let Some(i) = self.slots.iter().position(|s| {
            s.metadata
                .is_some_and(|m| m.event == event && m.status == KeyframeStatus::Provisional)
        }) {
            self.revoke_slot(i);
            true
        } else {
            false
        }
    }
}
impl<R> Drop for Pool<R> {
    fn drop(&mut self) {
        for slot in &self.slots {
            let mut r = slot.resource.lock().unwrap_or_else(|e| e.into_inner());
            r.id = None;
            r.value.take();
        }
    }
}
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Statistics {
    pub attempted: u64,
    pub succeeded: u64,
    pub replaced: u64,
    pub discarded: u64,
    pub capacity_drops: u64,
    pub no_match: u64,
    pub failures: u64,
    pub copies: u64,
    pub textures_created: u64,
    pub pool_sets: u64,
    pub average_submission_ms: f64,
    pub maximum_submission_ms: f64,
    pub manual_readbacks: u64,
    pub last_failure: Option<Failure>,
}
impl Statistics {
    fn failure(&mut self, error: Failure) {
        self.last_failure = Some(error);
        self.failures += 1;
        self.capacity_drops += u64::from(error == Failure::TierCCapacity);
        self.no_match += u64::from(matches!(
            error,
            Failure::NoTierBMatch | Failure::TemporalDeltaTooLarge
        ));
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub state: &'static str,
    pub generation: u64,
    pub config: Config,
    pub capacity: usize,
    pub memory_limited_capacity: usize,
    pub provisional: usize,
    pub confirmed: usize,
    pub pinned_slots: usize,
    pub width: u32,
    pub height: u32,
    pub bytes_per_frame: u64,
    pub allocated_payload: u64,
    pub occupied_payload: u64,
    pub physical_textures: usize,
    pub statistics: Statistics,
}
