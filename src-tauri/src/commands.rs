use std::sync::{Arc, Mutex, MutexGuard};
use tauri::State;

use crate::{
    capture::{self, CapturedFrame},
    change_detection::{self, DetectionConfig},
    error::AppError,
    platform::screen_capture::NativeScreenCapture,
    session::Session,
};

#[derive(Default)]
pub struct AppState(
    pub Arc<Mutex<Session>>,
    pub Arc<Mutex<crate::capture_backend::CaptureManager>>,
    pub Arc<crate::visual_context::VisualContextService>,
    pub Arc<crate::laya::Runtime>,
    pub Arc<crate::actions::Runtime>,
);

fn session(state: &AppState) -> Result<MutexGuard<'_, Session>, AppError> {
    state.0.lock().map_err(|error| {
        AppError::technical(
            "session_unavailable",
            "Session state is unavailable. Restart the application.",
            error,
        )
    })
}

fn stop_native_session(
    native: &Mutex<Session>,
    manager: &Mutex<crate::capture_backend::CaptureManager>,
) -> Result<(), AppError> {
    let mut capture = manager
        .lock()
        .map_err(|_| AppError::new("capture_unavailable", "Capture state unavailable."))?;
    native
        .lock()
        .map_err(|_| AppError::new("session_unavailable", "Session unavailable."))?
        .stop();
    capture.stop();
    Ok(())
}

fn apply_visual_access(
    native: &Mutex<Session>,
    manager: &Mutex<crate::capture_backend::CaptureManager>,
    enabled: bool,
) -> Result<(), AppError> {
    let mut capture = manager
        .lock()
        .map_err(|_| AppError::new("capture_unavailable", "Capture state unavailable."))?;
    let mut session = native
        .lock()
        .map_err(|_| AppError::new("session_unavailable", "Session unavailable."))?;
    session.set_ai_visual_access(false)?;
    if enabled {
        session.set_ai_visual_access(true)?;
        if let Err(error) = capture.start() {
            session.set_ai_visual_access(false)?;
            return Err(error);
        }
    } else {
        capture.stop();
    }
    Ok(())
}

#[tauri::command]
pub async fn start_session(
    state: State<'_, AppState>,
    memory: State<'_, crate::memory_commands::MemoryState>,
) -> Result<(), AppError> {
    memory.screen_awareness(false);
    state.2.invalidate();
    let (native, manager) = (state.0.clone(), state.1.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let mut capture = manager
            .lock()
            .map_err(|_| AppError::new("capture_unavailable", "Capture state unavailable."))?;
        capture.stop();
        native
            .lock()
            .map_err(|_| AppError::new("session_unavailable", "Session unavailable."))?
            .start();
        Ok(())
    })
    .await
    .map_err(|_| AppError::new("capture_worker_failed", "Capture startup failed."))?
}

#[tauri::command]
pub async fn stop_session(
    state: State<'_, AppState>,
    memory: State<'_, crate::memory_commands::MemoryState>,
) -> Result<(), AppError> {
    memory.screen_awareness(false);
    state.4.cancel(None);
    state.3.unload();
    state.2.invalidate();
    let (native, manager) = (state.0.clone(), state.1.clone());
    tauri::async_runtime::spawn_blocking(move || stop_native_session(&native, &manager))
        .await
        .map_err(|_| AppError::new("capture_worker_failed", "Capture shutdown failed."))?
}

#[tauri::command]
pub async fn capture_screen(
    state: State<'_, AppState>,
    threshold: f64,
    request: Option<crate::frame_optimizer::FrameRequest>,
) -> Result<CapturedFrame, AppError> {
    capture_impl(state, threshold, request.unwrap_or_default()).await
}

#[tauri::command]
pub async fn set_ai_visual_access(
    state: State<'_, AppState>,
    memory: State<'_, crate::memory_commands::MemoryState>,
    enabled: bool,
) -> Result<(), AppError> {
    memory.screen_awareness(false);
    if !enabled {
        state.3.unload();
    }
    state.2.invalidate();
    let (native, manager) = (state.0.clone(), state.1.clone());
    let service = memory.service.clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_visual_access(&native, &manager, enabled)?;
        // Never hold the Session/capture lock while waiting for the persistence
        // commit fence. Manual saves independently validate this generation.
        let permitted = native
            .lock()
            .map_err(|_| AppError::new("session_unavailable", "Session unavailable."))?
            .visual_access_generation()
            .is_ok();
        if let Some(service) = service {
            service.set_screen_awareness(enabled && permitted);
        }
        Ok(())
    })
    .await
    .map_err(|_| AppError::new("capture_worker_failed", "Capture configuration failed."))?
}

// Local developer preview only. Provider requests use VisualContextService.
async fn capture_impl(
    state: State<'_, AppState>,
    threshold: f64,
    request: crate::frame_optimizer::FrameRequest,
) -> Result<CapturedFrame, AppError> {
    change_detection::validate_threshold(threshold)?;
    let shared = state.0.clone();
    let (generation, previous) = {
        let mut s = session(&state)?;
        let (generation, _) = s.request_capture(false)?;
        (generation, s.previous_frame())
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let mut s = shared
                .lock()
                .map_err(|_| AppError::new("session_unavailable", "Session unavailable."))?;
            if !s.matches_generation(generation) {
                return Err(AppError::new("capture_cancelled", "Visual session ended."));
            }
            if s.begin_capture().is_ok() {
                break;
            }
            drop(s);
            if std::time::Instant::now() >= deadline {
                return Err(AppError::new("capture_busy", "Local capture is busy."));
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if request.kind == crate::frame_optimizer::FrameKind::Context {
                capture::capture(&NativeScreenCapture, previous.as_ref(), threshold)
            } else {
                capture::capture_optimized(
                    &NativeScreenCapture,
                    previous.as_ref(),
                    threshold,
                    None,
                    &request,
                )
            }
        }))
        .unwrap_or_else(|_| {
            Err(AppError::new(
                "capture_worker_failed",
                "Local capture failed.",
            ))
        });
        let mut s = shared
            .lock()
            .map_err(|_| AppError::new("session_unavailable", "Session unavailable."))?;
        match result {
            Ok((frame, current)) => {
                s.finish_capture(generation, Some(current))?;
                Ok(frame)
            }
            Err(e) => {
                s.finish_capture(generation, None)?;
                Err(e)
            }
        }
    })
    .await
    .map_err(|_| AppError::new("capture_worker_failed", "Local capture failed."));
    session(&state)?.finish_request();
    result?
}

#[tauri::command]
pub fn observer_snapshot(
    state: State<'_, AppState>,
) -> Result<crate::observer::Snapshot, AppError> {
    Ok(session(&state)?.observer.snapshot.clone())
}
#[tauri::command]
pub fn configure_observer(
    state: State<'_, AppState>,
    interval_ms: u64,
    stabilization_ms: u64,
) -> Result<(), AppError> {
    if !(100..=2000).contains(&interval_ms) || !(300..=700).contains(&stabilization_ms) {
        return Err(AppError::new(
            "invalid_config",
            "Observer interval must be 100-2000 ms; stabilization 300-700 ms.",
        ));
    }
    let mut s = session(&state)?;
    s.observer.snapshot.interval_ms = interval_ms;
    s.observer.snapshot.stabilization_ms = stabilization_ms;
    Ok(())
}
pub fn start_observer(shared: Arc<Mutex<Session>>) {
    std::thread::spawn(move || loop {
        use crate::platform::screen_capture::ScreenCaptureService;
        let started = std::time::Instant::now();
        let (ticket, interval) = match shared.lock() {
            Ok(mut s) => {
                let interval = s.observer.snapshot.interval_ms;
                let ticket = if s.observer.snapshot.active {
                    s.begin_capture().ok()
                } else {
                    None
                };
                (ticket, interval)
            }
            Err(_) => return,
        };
        if let Some(ticket) = ticket {
            let result = std::panic::catch_unwind(|| NativeScreenCapture.capture_primary_screen())
                .unwrap_or_else(|_| {
                    Err(AppError::new(
                        "capture_worker_failed",
                        "Local observation failed.",
                    ))
                });
            if let Ok(mut s) = shared.lock() {
                if s.finish_capture(ticket, None).is_ok() {
                    match result {
                        Ok(frame) => s.observer.observe(
                            &frame,
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64,
                            started.elapsed().as_secs_f64() * 1000.,
                        ),
                        Err(_) => {
                            s.observer.snapshot.error =
                                Some("Local observation failed; check display availability.")
                        }
                    }
                }
            }
        }
        // No catch-up queue: a slow sample delays/skips the next tick.
        std::thread::sleep(
            std::time::Duration::from_millis(interval)
                .saturating_sub(started.elapsed())
                .max(std::time::Duration::from_millis(10)),
        );
    });
}

#[tauri::command]
pub fn detection_config() -> DetectionConfig {
    change_detection::config()
}
