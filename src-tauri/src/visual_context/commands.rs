use super::*;
use crate::{capture_backend::BackendKind, commands::AppState};
use tauri::State;
fn sources(state: &AppState) -> Result<Arc<dyn Sources>> {
    let manager = state.1.lock().map_err(|_| error("current_unavailable"))?;
    if manager.selected == BackendKind::Legacy {
        return Ok(Arc::new(source::LegacySources));
    }
    #[cfg(windows)]
    if let (Some(recent), Some(history), Some(events)) = (
        manager.recent_gpu_cache(),
        manager.temporal_memory(),
        manager.event_memory(),
    ) {
        return Ok(Arc::new(source::gpu::NativeSources {
            recent,
            history,
            events,
        }));
    }
    Err(error("current_unavailable"))
}

use crate::routing::contract::Availability;
// A read-only projection for turn routing: no capture, readback, encoding,
// reservations, snapshot ownership or metadata identifiers cross this boundary.
#[tauri::command]
pub fn visual_context_availability(state: State<'_, AppState>, turn_id: String) -> Availability {
    routing_availability(&state.0, &state.2, sources(&state).ok(), &turn_id)
}
// Shared with the opt-in voice harness; it observes the identical native state.
pub(crate) fn routing_availability(
    session: &Arc<Mutex<Session>>,
    service: &VisualContextService,
    source: Option<Arc<dyn Sources>>,
    turn_id: &str,
) -> Availability {
    if session
        .lock()
        .map(|s| s.visual_access_generation().is_err())
        .unwrap_or(true)
    {
        return Availability::default();
    }
    let previous_reference_available = service.follow_up(session, turn_id).ok().flatten().is_some();
    let mut availability = Availability {
        screen_awareness_enabled: true,
        previous_reference_available,
        ..Default::default()
    };
    if let Some(source) = source {
        availability.current_available = source
            .latest()
            .ok()
            .flatten()
            .is_some_and(|a| a.available());
        let now = Instant::now();
        availability.recent_available = source
            .history(now - Duration::from_secs(5), now)
            .is_ok_and(|h| {
                h.events
                    .iter()
                    .any(|e| e.asset.as_ref().is_some_and(|a| a.available()))
            });
    }
    availability
}
#[tauri::command]
pub fn visual_context_begin_turn(
    state: State<'_, AppState>,
    turn_id: String,
    reference_age_ms: Option<f64>,
    conversation_id: Option<String>,
) -> Result<()> {
    state.2.begin_conversation_turn(
        &turn_id,
        reference_age_ms,
        conversation_id.as_deref().unwrap_or(&turn_id),
    )?;
    if reference_age_ms.is_some() {
        if let Ok(sources) = sources(&state) {
            state.2.reserve_history(sources, &state.0);
        }
    }
    Ok(())
}
#[tauri::command]
pub fn visual_context_cancel(state: State<'_, AppState>, preserve_follow_up: Option<bool>) {
    if preserve_follow_up == Some(true) {
        state.2.cancel_turn(true);
    } else {
        state.2.invalidate();
    }
}
#[tauri::command]
pub fn visual_context_note_delivery(
    state: State<'_, AppState>,
    turn_id: String,
    snapshot_ids: Vec<String>,
) -> Result<()> {
    state.2.note_delivery(&state.0, &turn_id, &snapshot_ids)
}
#[tauri::command]
pub fn visual_context_follow_up(
    state: State<'_, AppState>,
    turn_id: String,
) -> Result<Option<FollowUpContext>> {
    state.2.follow_up(&state.0, &turn_id)
}
#[tauri::command]
pub fn visual_context_complete_turn(state: State<'_, AppState>, turn_id: String) {
    state.2.complete_turn(&turn_id);
}
#[tauri::command]
pub async fn visual_context_mark_turn(state: State<'_, AppState>, turn_id: String) -> Result<()> {
    let mut request: Request =
        serde_json::from_value(serde_json::json!({"kind":"current", "turnId":turn_id}))
            .map_err(|_| error("invalid_arguments"))?;
    request.select_only = true;
    let receiver = state
        .2
        .request(request, sources(&state)?, state.0.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv()
            .unwrap_or_else(|_| Err(error("cancelled")))
            .map(|_| ())
    })
    .await
    .map_err(|_| error("cancelled"))?
}
#[tauri::command]
pub async fn visual_context_request(
    state: State<'_, AppState>,
    request: Request,
) -> Result<Response> {
    // Admission happens before spawn_blocking, bounding work even when callers
    // submit many IPC requests at once.
    let receiver = state
        .2
        .request(request, sources(&state)?, state.0.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver.recv().unwrap_or_else(|_| Err(error("cancelled")))
    })
    .await
    .map_err(|_| error("cancelled"))?
}
#[tauri::command]
pub fn visual_context_validate(
    state: State<'_, AppState>,
    epoch: u64,
    turn_id: String,
    snapshot_ids: Vec<String>,
    current: Option<bool>,
) -> Result<Option<f64>> {
    state.2.validate(&state.0, epoch, &turn_id, &snapshot_ids)?;
    if current == Some(true) {
        state.2.current_submission_age(&snapshot_ids).map(Some)
    } else {
        Ok(None)
    }
}
#[tauri::command]
pub fn visual_context_diagnostics(state: State<'_, AppState>) -> Diagnostics {
    state.2.diagnostics()
}
