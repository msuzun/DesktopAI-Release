use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

pub type Result<T> = std::result::Result<T, MemoryError>;

/// Stable IPC codes deliberately exclude database messages, paths and saved text.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct MemoryError {
    pub code: &'static str,
}
impl MemoryError {
    pub fn new(code: &'static str) -> Self {
        Self { code }
    }
}
impl From<rusqlite::Error> for MemoryError {
    fn from(error: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode;
        Self::new(match error.sqlite_error_code() {
            Some(ErrorCode::DiskFull) => "MEMORY_DISK_FULL",
            Some(ErrorCode::PermissionDenied | ErrorCode::ReadOnly) => "MEMORY_PERMISSION_DENIED",
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => "MEMORY_BUSY",
            _ => "MEMORY_DATABASE_UNAVAILABLE",
        })
    }
}
impl From<std::io::Error> for MemoryError {
    fn from(error: std::io::Error) -> Self {
        Self::new(if error.kind() == std::io::ErrorKind::PermissionDenied {
            "MEMORY_PERMISSION_DENIED"
        } else if matches!(error.raw_os_error(), Some(28 | 112)) {
            "MEMORY_DISK_FULL"
        } else {
            "MEMORY_WRITE_FAILED"
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryMode {
    Off,
    Manual,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StorageMode {
    Metadata,
    Thumbnail,
    Visual,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemorySettings {
    pub mode: MemoryMode,
    pub paused: bool,
    /// Separate consent for selected M7 events; existing libraries remain
    /// manual when this field is absent from their saved preferences.
    #[serde(default)]
    pub automatic_memory_enabled: bool,
    pub storage_mode: StorageMode,
    pub retention_days: u32,
    pub storage_limit_mb: u32,
}
impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            mode: MemoryMode::Off,
            paused: false,
            automatic_memory_enabled: false,
            storage_mode: StorageMode::Metadata,
            retention_days: 7,
            storage_limit_mb: 256,
        }
    }
}
impl MemorySettings {
    pub fn validate(&self) -> Result<()> {
        if !(1..=365).contains(&self.retention_days)
            || !(16..=4096).contains(&self.storage_limit_mb)
        {
            return Err(MemoryError::new("MEMORY_INVALID_REQUEST"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandidateOrigin {
    Explicit,
    MeaningfulStableState,
    ImportantTransient,
}
impl CandidateOrigin {
    pub(crate) fn event_kind(self) -> &'static str {
        match self {
            Self::Explicit => "explicit_save",
            Self::MeaningfulStableState => "meaningful_stable_state",
            Self::ImportantTransient => "important_transient",
        }
    }
    pub(crate) fn save_reason(self) -> &'static str {
        match self {
            Self::Explicit => "user_requested",
            Self::MeaningfulStableState => "selected_stable_change",
            Self::ImportantTransient => "selected_transient",
        }
    }
    pub(crate) fn summary_source(self) -> &'static str {
        if self == Self::Explicit {
            "user"
        } else {
            "system_metadata"
        }
    }
}

/// Application-owned candidate, never serialized from the frontend. Owned pixels
/// originate from an explicit save or a separately consented, selected M7 event;
/// no capture-stream frame queue feeds persistence.
pub struct MemoryCandidate {
    pub origin: CandidateOrigin,
    pub observed_at: i64,
    pub session_id: String,
    pub label: String,
    pub image: Option<image::RgbaImage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub observed_at: i64,
    pub persisted_at: i64,
    pub session_id: String,
    pub event_kind: String,
    pub summary: String,
    pub summary_source: String,
    pub source_application: Option<String>,
    pub window_title: Option<String>,
    pub save_reason: String,
    pub bookmarked: bool,
    pub has_visual: bool,
    pub has_thumbnail: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub expires_at: Option<i64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryCursor {
    pub observed_at: i64,
    pub id: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryQuery {
    pub text: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub bookmarked_only: Option<bool>,
    pub source_application: Option<String>,
    pub cursor: Option<MemoryCursor>,
    pub limit: Option<u32>,
}
impl MemoryQuery {
    pub fn validate(&self) -> Result<()> {
        if self.text.as_ref().is_some_and(|s| s.len() > 512)
            || self
                .source_application
                .as_ref()
                .is_some_and(|s| s.len() > 256)
            || self.limit.is_some_and(|n| n == 0 || n > 50)
            || matches!((self.from,self.to),(Some(a),Some(b)) if a > b)
            || self
                .cursor
                .as_ref()
                .is_some_and(|c| uuid::Uuid::parse_str(&c.id).is_err())
        {
            return Err(MemoryError::new("MEMORY_INVALID_REQUEST"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPage {
    pub items: Vec<MemoryRecord>,
    pub next_cursor: Option<MemoryCursor>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatus {
    pub settings: MemorySettings,
    pub health: String,
    pub error_code: Option<String>,
    pub saved_count: u64,
    pub storage_bytes: u64,
    pub queue_depth: usize,
    pub screen_awareness: bool,
    pub encrypted: bool,
    pub semantic_search: bool,
    pub schema_version: u32,
    pub writes: u64,
    pub rejected: u64,
    pub candidates: u64,
    pub deduplicated: u64,
    pub queue_max_depth: usize,
    pub db_bytes: u64,
    pub assets_bytes: u64,
    pub thumbnails_bytes: u64,
    pub encode_p50_ms: f64,
    pub encode_p95_ms: f64,
    pub write_p50_ms: f64,
    pub write_p95_ms: f64,
    pub transaction_p50_ms: f64,
    pub transaction_p95_ms: f64,
}
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
pub fn validate_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| MemoryError::new("MEMORY_INVALID_REQUEST"))
}

/// Semantic retrieval is explicitly unavailable. This boundary prevents future
/// embedded vector SQL from leaking into the relational repository or UI.
pub trait MemorySemanticIndex: Send {
    fn available(&self) -> bool;
    fn remove(&mut self, memory_id: &str) -> Result<()>;
    fn clear(&mut self) -> Result<()>;
}
pub struct NoSemanticIndex;
impl MemorySemanticIndex for NoSemanticIndex {
    fn available(&self) -> bool {
        false
    }
    fn remove(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
    fn clear(&mut self) -> Result<()> {
        Ok(())
    }
}
