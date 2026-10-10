//! JEV credential management. Action-intent classification is owned by crate::actions.
use crate::{
    actions::{MODEL, TIMEOUT_MS},
    routing::contract::{Failure, Result},
};
use serde::Serialize;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    configured: bool,
    source: &'static str,
    model: &'static str,
    timeout_ms: u64,
    authority_available: bool,
}
#[tauri::command]
pub async fn jev_status() -> Result<Status> {
    tauri::async_runtime::spawn_blocking(|| {
        let configured = crate::voice::load_jev_key()
            .map_err(|_| Failure::CredentialStore)?
            .is_some();
        let environment = ["JEV_API_KEY", "TYPESAFE_API_KEY"]
            .iter()
            .any(|name| std::env::var(name).is_ok_and(|v| !v.trim().is_empty() && v.len() <= 4096));
        Ok(Status {
            configured,
            source: if environment {
                "environment"
            } else if configured {
                "credential_store"
            } else {
                "none"
            },
            model: MODEL,
            timeout_ms: TIMEOUT_MS,
            authority_available: false,
        })
    })
    .await
    .map_err(|_| Failure::CredentialStore)?
}
#[tauri::command]
pub async fn jev_save_key(
    state: tauri::State<'_, crate::commands::AppState>,
    secret: String,
) -> Result<()> {
    state.4.configure(false);
    crate::voice::save_voice_key("jev".into(), secret)
        .await
        .map_err(|_| Failure::CredentialStore)
}
#[tauri::command]
pub async fn jev_delete_key(state: tauri::State<'_, crate::commands::AppState>) -> Result<()> {
    state.4.configure(false);
    crate::voice::delete_voice_key("jev".into())
        .await
        .map_err(|_| Failure::CredentialStore)
}
