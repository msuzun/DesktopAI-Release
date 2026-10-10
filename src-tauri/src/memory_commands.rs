//! Typed IPC for local memory. Neither paths, SQL nor frontend image bytes are
//! accepted. Capture occurs only for a manually selected moment, off the UI and
//! perception threads, after both independent permissions have been checked.
use crate::persistent_memory::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::State;

/// Optional isolated profiles are UUIDs, never filesystem paths. They
/// cannot redirect asset operations outside the application-owned data root.
pub fn storage_root(base: std::path::PathBuf) -> Option<std::path::PathBuf> {
    match std::env::var("COMPANION_PROFILE") {
        Ok(profile) => uuid::Uuid::parse_str(&profile)
            .ok()
            .map(|id| base.join("profiles").join(id.to_string()).join("memory")),
        Err(std::env::VarError::NotPresent) => Some(base.join("memory")),
        Err(_) => None,
    }
}

pub struct MemoryState {
    pub service: Option<Arc<MemoryService>>,
    location: Option<String>,
    preparing: Arc<AtomicBool>,
    run_id: String,
    #[cfg(windows)]
    automatic: std::sync::Mutex<Option<crate::automatic_memory::AutomaticMemory>>,
}
impl MemoryState {
    pub fn new(root: Option<std::path::PathBuf>) -> Self {
        Self {
            location: root.as_ref().map(|p| p.to_string_lossy().into_owned()),
            service: root.map(|p| Arc::new(MemoryService::new(p))),
            preparing: Arc::new(AtomicBool::new(false)),
            run_id: uuid::Uuid::new_v4().to_string(),
            #[cfg(windows)]
            automatic: std::sync::Mutex::new(None),
        }
    }
    fn service(&self) -> Result<Arc<MemoryService>> {
        self.service
            .clone()
            .ok_or_else(|| MemoryError::new("MEMORY_UNAVAILABLE"))
    }
    pub fn screen_awareness(&self, enabled: bool) {
        if let Some(service) = &self.service {
            service.set_screen_awareness(enabled);
        }
    }
    pub fn shutdown(&self) {
        #[cfg(windows)]
        if let Ok(automatic) = self.automatic.lock() {
            if let Some(automatic) = automatic.as_ref() {
                automatic.stop();
            }
        }
        if let Some(service) = &self.service {
            service.shutdown();
        }
    }
    #[cfg(windows)]
    pub fn start_automatic(&self, state: &crate::commands::AppState) {
        if let (Some(service), Ok(mut automatic)) = (&self.service, self.automatic.lock()) {
            if automatic.is_none() {
                *automatic = crate::automatic_memory::AutomaticMemory::start(
                    service.clone(),
                    state.0.clone(),
                    state.1.clone(),
                    self.run_id.clone(),
                );
            }
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    #[serde(flatten)]
    status: MemoryStatus,
    storage_location: Option<String>,
}
#[tauri::command]
pub async fn memory_status(memory: State<'_, MemoryState>) -> Result<MemoryInfo> {
    let service = memory.service()?;
    let storage_location = memory.location.clone();
    background(move || {
        Ok(MemoryInfo {
            status: service.status(),
            storage_location,
        })
    })
    .await
}

async fn background<T: Send + 'static>(
    job: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?
}

#[tauri::command]
pub async fn memory_configure(
    memory: State<'_, MemoryState>,
    settings: MemorySettings,
) -> Result<MemoryStatus> {
    settings.validate()?;
    let service = memory.service()?;
    background(move || service.configure(settings)).await
}
#[tauri::command]
pub async fn memory_search(
    memory: State<'_, MemoryState>,
    query: MemoryQuery,
) -> Result<MemoryPage> {
    query.validate()?;
    let service = memory.service()?;
    background(move || service.search(query)).await
}
#[tauri::command]
pub async fn memory_get(memory: State<'_, MemoryState>, id: String) -> Result<MemoryRecord> {
    validate_id(&id)?;
    let service = memory.service()?;
    background(move || service.get(id)).await
}
#[tauri::command]
pub async fn memory_bookmark(
    memory: State<'_, MemoryState>,
    id: String,
    bookmarked: bool,
) -> Result<MemoryRecord> {
    validate_id(&id)?;
    let service = memory.service()?;
    background(move || service.bookmark(id, bookmarked)).await
}
#[tauri::command]
pub async fn memory_delete(memory: State<'_, MemoryState>, id: String) -> Result<()> {
    validate_id(&id)?;
    let service = memory.service()?;
    background(move || service.delete(id)).await
}
#[tauri::command]
pub async fn memory_delete_range(
    memory: State<'_, MemoryState>,
    from: i64,
    to: i64,
) -> Result<u64> {
    if from > to {
        return Err(MemoryError::new("MEMORY_INVALID_REQUEST"));
    }
    let service = memory.service()?;
    background(move || service.delete_range(from, to)).await
}
#[tauri::command]
pub async fn memory_clear(memory: State<'_, MemoryState>, confirmed: bool) -> Result<()> {
    let service = memory.service()?;
    background(move || service.clear(confirmed)).await
}
#[tauri::command]
pub async fn memory_asset(
    memory: State<'_, MemoryState>,
    id: String,
    thumbnail: bool,
) -> Result<tauri::ipc::Response> {
    validate_id(&id)?;
    let service = memory.service()?;
    background(move || {
        let bytes = service.asset(id, thumbnail)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

struct PreparationGuard(Arc<AtomicBool>);
impl Drop for PreparationGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn memory_remember(
    memory: State<'_, MemoryState>,
    state: State<'_, crate::commands::AppState>,
    label: Option<String>,
) -> Result<MemoryRecord> {
    let label = label.unwrap_or_default().trim().to_owned();
    if label.len() > 512 {
        return Err(MemoryError::new("MEMORY_INVALID_REQUEST"));
    }
    let service = memory.service()?;
    // Reserve the memory generation BEFORE preparing pixels. A clear, pause,
    // disable or session change during capture invalidates this exact ticket.
    let ticket = service.try_begin_candidate()?;
    let native = state.0.clone();
    let generation = native
        .lock()
        .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?
        .visual_access_generation()
        .map_err(|_| MemoryError::new("MEMORY_SCREEN_AWARENESS_OFF"))?;
    memory
        .preparing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| MemoryError::new("MEMORY_BUSY"))?;
    let guard = PreparationGuard(memory.preparing.clone());
    let session_id = format!("{}-{generation}", memory.run_id);
    background(move || {
        let _guard = guard;
        use crate::platform::screen_capture::ScreenCaptureService;
        if !native
            .lock()
            .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?
            .visual_access_valid(generation)
        {
            return Err(MemoryError::new("MEMORY_SCREEN_AWARENESS_OFF"));
        }
        let observed_at = now_ms();
        let image = if ticket.storage_mode() == StorageMode::Metadata {
            None
        } else {
            Some(
                crate::platform::screen_capture::NativeScreenCapture
                    .capture_primary_screen()
                    .map_err(|_| MemoryError::new("MEMORY_CAPTURE_UNAVAILABLE"))?,
            )
        };
        if !native
            .lock()
            .map_err(|_| MemoryError::new("MEMORY_UNAVAILABLE"))?
            .visual_access_valid(generation)
        {
            return Err(MemoryError::new("MEMORY_SCREEN_AWARENESS_OFF"));
        }
        service.save(
            ticket,
            MemoryCandidate {
                origin: CandidateOrigin::Explicit,
                observed_at,
                session_id,
                label,
                image,
            },
        )
    })
    .await
}
