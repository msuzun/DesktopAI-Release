//! Local temporal patterns only. No semantic labels, providers, or image history.
mod detector;
mod signal;
mod timeline;
pub use signal::StateSignal;
#[cfg(windows)]
mod worker;
use crate::{
    temporal_memory::{SampleId, SampleMetadata},
    visual_analysis::Bounds,
};
pub use detector::{compare_luma, Action, Detector, Evidence};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
pub use timeline::VisualEventTimeline;
#[cfg(windows)]
pub use worker::{Diagnostics, EventEngine, EventMemory, EventSink};
#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub stability_window: Duration,
    pub minimum_samples: u32,
    pub maximum_sample_gap: Duration,
    pub stable_score: f64,
    pub stable_area: f64,
    pub stable_tiles: u32,
    pub start_score: f64,
    pub start_area: f64,
    pub continue_score: f64,
    pub continue_area: f64,
    pub broad_area: f64,
    pub transient_min: Duration,
    pub transient_max: Duration,
    pub overlap: f64,
    pub return_score: f64,
    pub return_area: f64,
    pub return_window: Duration,
    pub cooldown: Duration,
    pub provisional_confidence: f64,
    pub replacement_improvement: f64,
    pub replacement_interval: Duration,
    pub maximum_replacements: u32,
    pub correlation_delta: Duration,
    pub baseline_check_interval: Duration,
    pub retention: Duration,
    pub timeline_capacity: usize,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            stability_window: Duration::from_millis(250),
            minimum_samples: 3,
            maximum_sample_gap: Duration::from_millis(200),
            stable_score: 0.002,
            stable_area: 0.008,
            stable_tiles: 2,
            start_score: 0.004,
            start_area: 0.012,
            continue_score: 0.003,
            continue_area: 0.008,
            broad_area: 0.30,
            transient_min: Duration::from_millis(100),
            transient_max: Duration::from_millis(1500),
            overlap: 0.25,
            return_score: 0.0025,
            return_area: 0.006,
            return_window: Duration::from_millis(66),
            cooldown: Duration::from_millis(750),
            provisional_confidence: 0.72,
            replacement_improvement: 0.08,
            replacement_interval: Duration::from_millis(80),
            maximum_replacements: 2,
            correlation_delta: Duration::from_millis(50),
            baseline_check_interval: Duration::from_millis(250),
            retention: Duration::from_secs(5),
            timeline_capacity: 64,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventId {
    pub generation: u64,
    pub sequence: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyframeId {
    pub generation: u64,
    pub sequence: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum EventType {
    SceneTransition,
    StableSceneEstablished,
    LocalizedTransient,
    LocalizedPersistentChange,
    ReturnToStableState,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum EventStatus {
    Candidate,
    Active,
    Completed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum KeyframeType {
    Stable,
    Transient,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum KeyframeStatus {
    Provisional,
    Confirmed,
}
#[derive(Clone, Copy, Debug)]
pub struct Moment {
    pub temporal_id: SampleId,
    pub timestamp: Instant,
}
impl From<SampleMetadata> for Moment {
    fn from(m: SampleMetadata) -> Self {
        Self {
            temporal_id: m.id,
            timestamp: m.source_timestamp,
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct VisualEvent {
    pub id: EventId,
    pub kind: EventType,
    pub status: EventStatus,
    pub start: Moment,
    pub peak: Moment,
    pub end: Option<Moment>,
    pub peak_score: f64,
    pub peak_area: f64,
    pub bounds: Option<Bounds>,
    pub detection_confidence: f64,
    pub scene_sequence: u64,
    pub keyframe: Option<KeyframeId>,
}
impl VisualEvent {
    pub fn duration(&self, now: Instant) -> Duration {
        self.end
            .map_or(now, |m| m.timestamp)
            .saturating_duration_since(self.start.timestamp)
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Promotion {
    pub event: EventId,
    pub sample: SampleMetadata,
    pub kind: KeyframeType,
    pub status: KeyframeStatus,
    pub detection_confidence: f64,
    pub selection_confidence: f64,
    pub maximum_delta: Duration,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Difference {
    pub score: f64,
    pub area: f64,
    pub bounds: Option<Bounds>,
}

/// Metadata only, assembled from the detector and its existing bounded timeline.
#[derive(Clone, Copy, Default)]
pub struct TurnState {
    pub observed_at: Option<Instant>,
    pub scene: u64,
    pub stable: bool,
    pub stable_event: Option<VisualEvent>,
    pub at_turn: Option<VisualEvent>,
    pub post_turn_change: Option<Instant>,
}
