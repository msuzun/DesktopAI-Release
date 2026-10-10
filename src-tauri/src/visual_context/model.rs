use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const PREFERRED_AGE: Duration = Duration::from_millis(100);
pub const HARD_AGE: Duration = Duration::from_millis(500);
// An endpoint snapshot is acquired fresh before VAD trailing silence. Its
// separate delivery budget never authorizes selecting a multi-second-old image.
pub const TURN_DELIVERY_AGE: Duration = Duration::from_millis(2000);
pub const FRESH_WAIT: Duration = Duration::from_millis(250);
pub const LIFETIME: Duration = Duration::from_secs(5);
// A selected, delivered historical moment only. Absolute from selection, never
// renewed by tools, and at most one subsequent conversational user turn.
pub const FOLLOW_UP_LIFETIME: Duration = Duration::from_secs(15);
pub const SNAPSHOT_CAPACITY: usize = 5; // One current source and four historical references.
pub const SNAPSHOT_GPU_BUDGET: u64 = 64 * 1024 * 1024;
pub const MAX_EVENTS: usize = 16;
pub const MAX_IMAGES: usize = 4;
pub const MAX_TURN_IMAGES: usize = 8;
pub type Result<T> = std::result::Result<T, AppError>;
pub fn error(code: &'static str) -> AppError {
    AppError::new(
        code,
        match code {
            "permission_denied" => "Screen Awareness is off. No visual context is available.",
            "snapshot_expired" => {
                "The requested visual moment expired. No replacement image was selected."
            }
            "snapshot_required" => "Request Current or Recent first, then inspect its snapshot.",
            "current_unavailable" => "No sufficiently recent current frame is available.",
            "history_unavailable" => "Recent visual history is unavailable.",
            "invalid_region" => "Use a positive normalized region entirely within the image.",
            "invalid_arguments" => "Visual context arguments are outside the supported limits.",
            "visual_limit_reached" => {
                "The visual request limit for this turn was reached. Do not repeat the request."
            }
            "visual_busy" => "Visual preparation is busy. No additional work was queued.",
            "generation_changed" => {
                "Visual sources changed. The previous context is no longer valid."
            }
            "cancelled" => "This visual request was cancelled or superseded.",
            "image_too_large" => {
                "The encoded image exceeds the delivery limit. Request a smaller detail region."
            }
            "readback_failed" => "The selected visual source could not be read.",
            "encoding_failed" => "The selected visual source could not be encoded.",
            _ => "Visual context is unavailable.",
        },
    )
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Current,
    Detail,
    Recent,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Region {
    pub fn pixels(self, width: u32, height: u32) -> Result<crate::observer::Region> {
        let values = [self.x, self.y, self.width, self.height];
        if !values.iter().all(|v| v.is_finite())
            || self.x < 0.
            || self.y < 0.
            || self.width <= 0.
            || self.height <= 0.
            || self.x + self.width > 1. + 1e-9
            || self.y + self.height > 1. + 1e-9
            || width == 0
            || height == 0
        {
            return Err(error("invalid_region"));
        }
        let x = (self.x * width as f64).floor() as u32;
        let y = (self.y * height as f64).floor() as u32;
        let right = ((self.x + self.width).min(1.) * width as f64).ceil() as u32;
        let bottom = ((self.y + self.height).min(1.) * height as f64).ceil() as u32;
        if x >= width || y >= height || right <= x || bottom <= y {
            return Err(error("invalid_region"));
        }
        Ok(crate::observer::Region {
            x,
            y,
            width: right - x,
            height: bottom - y,
        })
    }
}
fn default_lookback() -> u64 {
    5000
}
fn default_events() -> usize {
    8
}
fn default_images() -> usize {
    3
}
fn default_bytes() -> usize {
    1_048_576
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    #[serde(skip)]
    pub select_only: bool,
    pub kind: Kind,
    pub turn_id: String,
    pub snapshot_id: Option<String>,
    pub region: Option<Region>,
    #[serde(default = "default_lookback")]
    pub lookback_ms: u64,
    #[serde(default = "default_events")]
    pub max_events: usize,
    #[serde(default = "default_images")]
    pub max_keyframes: usize,
    #[serde(default = "default_images")]
    pub image_limit: usize,
    #[serde(default = "default_bytes")]
    pub max_encoded_bytes: usize,
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        if self.turn_id.is_empty()
            || self.turn_id.len() > 100
            || self
                .snapshot_id
                .as_ref()
                .is_some_and(|s| s.len() > 100 || s.is_empty())
            || self.lookback_ms == 0
            || self.lookback_ms > 5000
            || self.max_events == 0
            || self.max_events > MAX_EVENTS
            || self.max_keyframes > MAX_IMAGES
            || self.image_limit > MAX_IMAGES
            || self.max_encoded_bytes == 0
            || self.max_encoded_bytes > default_bytes()
            || (self.kind != Kind::Detail && (self.region.is_some() || self.snapshot_id.is_some()))
        {
            return Err(error("invalid_arguments"));
        }
        if let Some(region) = self.region {
            region.pixels(1, 1)?;
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Role {
    Current,
    Detail,
    RecentStable,
    RecentTransient,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Freshness {
    Fresh,
    Stale,
    Historical,
    Unavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Completeness {
    Complete,
    Partial,
    Empty,
}
#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    pub permission_ms: f64,
    pub selection_ms: f64,
    pub wait_ms: f64,
    pub capture_ms: f64,
    pub readback_ms: f64,
    pub crop_ms: f64,
    pub encoding_ms: f64,
    pub assembly_ms: f64,
    pub total_ms: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub snapshot_id: String,
    pub role: Role,
    pub origin: Role,
    pub timestamp_unix_ms: f64,
    pub age_ms: f64,
    pub offset_ms: f64,
    pub original_width: u32,
    pub original_height: u32,
    pub width: u32,
    pub height: u32,
    pub source_region: Option<Region>,
    pub correlation: &'static str,
    pub correlation_delta_ms: f64,
    pub mime_type: &'static str,
    pub encoded_size_bytes: usize,
    pub base64: String,
}
impl Drop for Frame {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.base64.zeroize();
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub description: &'static str,
    pub start_offset_ms: f64,
    pub peak_offset_ms: f64,
    pub end_offset_ms: Option<f64>,
    pub duration_ms: f64,
    pub confidence: f64,
    pub region: Option<Region>,
    pub snapshot_id: Option<String>,
    pub active: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpContext {
    pub snapshot_id: String,
    pub origin_turn_id: String,
    pub origin: Role,
    pub expires_at_unix_ms: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub follow_up_reference: Option<FollowUpContext>,
    pub current_max_age_ms: Option<f64>,
    pub temporal_role: Option<&'static str>,
    pub request_id: String,
    pub turn_id: String,
    pub epoch: u64,
    pub kind: Kind,
    pub generated_at_unix_ms: f64,
    pub reference_time_unix_ms: f64,
    pub freshness: Freshness,
    pub completeness: Completeness,
    pub requested_lookback_ms: u64,
    pub actual_coverage_ms: f64,
    pub truncated: bool,
    pub warnings: Vec<&'static str>,
    pub events: Vec<Event>,
    pub frames: Vec<Frame>,
    pub timings: Timings,
}
pub fn millis(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.
}
pub fn offset(time: Instant, reference: Instant) -> f64 {
    if time >= reference {
        millis(time - reference)
    } else {
        -millis(reference - time)
    }
}
pub fn unix(time: Instant) -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.
        + offset(time, Instant::now())
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metric {
    pub requests: u64,
    pub succeeded: u64,
    pub failed: u64,
    pub cancelled: u64,
    pub immediate: u64,
    pub after_wait: u64,
    pub stale: u64,
    pub unavailable: u64,
    pub expired: u64,
    pub roi: u64,
    pub full_frame: u64,
    pub truncated: u64,
    pub empty: u64,
    pub frames: u64,
    pub events: u64,
    pub events_considered: u64,
    pub keyframes_considered: u64,
    pub encoded_bytes: u64,
    pub total_age_ms: f64,
    pub maximum_age_ms: f64,
    pub total_coverage_ms: f64,
    pub total_lookback_ms: f64,
    pub total: Timings,
    pub maximum_ms: f64,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDiagnostic {
    pub turn_id: String,
    pub reference_unix_ms: f64,
    pub requested_unix_ms: f64,
    pub reference_age_ms: f64,
    pub lookback_ms: u64,
    pub coverage_ms: f64,
    pub source_generation: [u64; 3],
    pub used_turn_reservation: bool,
    pub events_considered: usize,
    pub keyframes_considered: usize,
    pub events_selected: usize,
    pub encoded_images: usize,
    pub encoded_bytes: usize,
    pub status: String,
    pub snapshots: Vec<HistoricalDiagnostic>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalDiagnostic {
    pub snapshot_id: String,
    pub role: Role,
    pub source_unix_ms: f64,
    pub offset_ms: f64,
    pub source_width: u32,
    pub source_height: u32,
    pub width: u32,
    pub height: u32,
    pub created_unix_ms: f64,
    pub expires_unix_ms: f64,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionMetrics {
    pub requests: u64,
    pub succeeded: u64,
    pub failed: u64,
    pub cancelled: u64,
    pub alignment_rejected: u64,
    pub last_rejection: Option<AlignmentRejection>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentRejection {
    pub turn_id: String,
    pub source: &'static str,
    pub offset_ms: f64,
    pub limit_ms: f64,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub selection: SelectionMetrics,
    pub follow_up: Option<FollowUpDiagnostic>,
    pub follow_up_capacity: usize,
    pub last_recent: Option<RecentDiagnostic>,
    pub turn_sync: super::turn::Metrics,
    pub current: Metric,
    pub detail: Metric,
    pub recent: Metric,
    pub snapshots: usize,
    pub snapshot_capacity: usize,
    pub snapshot_gpu_bytes: u64,
    pub reserved_history_events: usize,
    pub reserved_history_keyframes: usize,
    pub active_jobs: usize,
    pub queued_jobs: usize,
    pub rejected_busy: u64,
    pub readback_failures: u64,
    pub encoding_failures: u64,
    pub last_kind: Option<Kind>,
    pub last_status: Option<&'static str>,
    pub last_turn_id: Option<String>,
    pub last_error: Option<&'static str>,
    pub last_timings: Timings,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpDiagnostic {
    pub snapshot_id: String,
    pub origin_turn_id: String,
    pub remaining_turns: u8,
    pub completed: bool,
    pub expires_in_ms: f64,
}
impl Diagnostics {
    pub fn metric(&mut self, kind: Kind) -> &mut Metric {
        match kind {
            Kind::Current => &mut self.current,
            Kind::Detail => &mut self.detail,
            Kind::Recent => &mut self.recent,
        }
    }
}
