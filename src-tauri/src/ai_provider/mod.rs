//! Application-owned provider profiles and cancellable native transport.
//! Long-lived credentials never enter the webview; profile IDs bind them to an endpoint.
pub(crate) mod transport;

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::Mutex,
};
use tauri::State;
use tokio::sync::watch;
use zeroize::Zeroizing;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderError {
    pub code: &'static str,
    pub message: &'static str,
}
pub(super) fn error(code: &'static str, message: &'static str) -> ProviderError {
    ProviderError { code, message }
}
pub(super) type Result<T> = std::result::Result<T, ProviderError>;
pub(super) fn config_error() -> ProviderError {
    error("PROVIDER_CONFIG", "Check the provider configuration.")
}
pub(super) fn cancelled() -> ProviderError {
    error("CANCELLED", "The request was cancelled.")
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capabilities {
    pub text_input: bool,
    pub text_output: bool,
    pub vision: bool,
    pub multi_image: bool,
    pub streaming: bool,
    pub native_audio_input: bool,
    pub native_audio_output: bool,
    pub realtime: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub display_name: String,
    pub adapter_type: String,
    pub base_url: String,
    pub model: String,
    pub capabilities: Capabilities,
    pub auth: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileFile {
    schema_version: u32,
    profiles: Vec<Profile>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawProfileFile {
    schema_version: u32,
    profiles: Vec<serde_json::Value>,
}
struct Profiles {
    values: Vec<Profile>,
    load_failed: bool,
}
struct Active {
    profile_id: String,
    cancel: watch::Sender<bool>,
}
#[derive(Default)]
struct Jobs {
    active: HashMap<String, Active>,
    cancelled: VecDeque<String>,
}
pub struct ProviderState {
    root: Option<PathBuf>,
    profiles: Mutex<Profiles>,
    jobs: Mutex<Jobs>,
}
/// Isolate provider settings under an optional UUID profile without accepting paths.
pub fn storage_root(base: PathBuf) -> Option<PathBuf> {
    match std::env::var("COMPANION_PROFILE") {
        Ok(profile) => uuid::Uuid::parse_str(&profile)
            .ok()
            .map(|id| base.join("profiles").join(id.to_string())),
        Err(std::env::VarError::NotPresent) => Some(base),
        Err(_) => None,
    }
}
impl ProviderState {
    pub fn new(root: Option<PathBuf>) -> Self {
        let mut values = Vec::new();
        let mut load_failed = false;
        if let Some(path) = root.as_ref().map(|root| root.join("providers-v1.json")) {
            let bytes = match std::fs::metadata(&path) {
                Ok(metadata) if metadata.len() > 128 * 1024 => {
                    Err(std::io::Error::other("oversized provider settings"))
                }
                Ok(_) => std::fs::File::open(&path).and_then(|file| {
                    use std::io::Read;
                    let mut data = Vec::new();
                    file.take(128 * 1024 + 1).read_to_end(&mut data)?;
                    Ok(data)
                }),
                Err(error) => Err(error),
            };
            match bytes {
                Ok(bytes) if bytes.len() <= 128 * 1024 => {
                    match serde_json::from_slice::<RawProfileFile>(&bytes) {
                        Ok(file) if file.schema_version == 1 && file.profiles.len() <= 32 => {
                            for raw_profile in file.profiles {
                                let Ok(profile) = serde_json::from_value::<Profile>(raw_profile)
                                else {
                                    load_failed = true;
                                    continue;
                                };
                                if validate_profile(&profile).is_ok()
                                    && !values.iter().any(|p: &Profile| p.id == profile.id)
                                {
                                    values.push(profile);
                                } else {
                                    load_failed = true;
                                }
                            }
                        }
                        _ => load_failed = true,
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                _ => load_failed = true,
            }
        }
        Self {
            root,
            profiles: Mutex::new(Profiles {
                values,
                load_failed,
            }),
            jobs: Mutex::new(Jobs::default()),
        }
    }
    fn profile(&self, id: &str) -> Result<Profile> {
        self.profiles
            .lock()
            .map_err(|_| config_error())?
            .values
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(config_error)
    }
    fn persist(&self, values: &[Profile]) -> Result<()> {
        let root = self.root.as_ref().ok_or_else(|| {
            error(
                "PROVIDER_STORAGE",
                "Provider settings storage is unavailable.",
            )
        })?;
        std::fs::create_dir_all(root)
            .map_err(|_| error("PROVIDER_STORAGE", "Provider settings could not be saved."))?;
        let data = serde_json::to_vec(&ProfileFile {
            schema_version: 1,
            profiles: values.to_vec(),
        })
        .map_err(|_| config_error())?;
        let temporary = root.join("providers-v1.pending");
        std::fs::write(&temporary, data)
            .and_then(|_| std::fs::rename(&temporary, root.join("providers-v1.json")))
            .map_err(|_| error("PROVIDER_STORAGE", "Provider settings could not be saved."))
    }
    fn begin(&self, id: &str, profile_id: &str) -> Result<watch::Receiver<bool>> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':'))
        {
            return Err(config_error());
        }
        let mut jobs = self.jobs.lock().map_err(|_| config_error())?;
        if jobs.cancelled.iter().any(|value| value == id) {
            return Err(cancelled());
        }
        if jobs.active.len() >= 8 || jobs.active.contains_key(id) {
            return Err(error("PROVIDER_BUSY", "Too many active requests."));
        }
        let (cancel, receiver) = watch::channel(false);
        jobs.active.insert(
            id.to_owned(),
            Active {
                profile_id: profile_id.to_owned(),
                cancel,
            },
        );
        Ok(receiver)
    }
    fn finish(&self, id: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.active.remove(id);
        }
    }
    fn cancel_profile(&self, id: &str) {
        if let Ok(jobs) = self.jobs.lock() {
            for job in jobs.active.values().filter(|job| job.profile_id == id) {
                let _ = job.cancel.send(true);
            }
        }
    }
    pub fn shutdown(&self) {
        if let Ok(jobs) = self.jobs.lock() {
            for job in jobs.active.values() {
                let _ = job.cancel.send(true);
            }
        }
    }
}
fn validate_profile(profile: &Profile) -> Result<()> {
    if uuid::Uuid::parse_str(&profile.id).is_err()
        || profile.display_name.trim().is_empty()
        || profile.display_name.chars().count() > 100
        || profile.display_name.chars().any(char::is_control)
        || profile.model.trim().is_empty()
        || profile.model.len() > 200
        || profile.model.chars().any(char::is_control)
        || !matches!(profile.auth.as_str(), "none" | "apiKey")
        || profile
            .voice
            .as_ref()
            .is_some_and(|voice| voice.len() > 100 || voice.chars().any(char::is_control))
    {
        return Err(config_error());
    }
    if !matches!(
        profile.adapter_type.as_str(),
        "openai-compatible" | "anthropic" | "openai-transcription" | "openai-speech"
    ) {
        return Err(config_error());
    }
    transport::base_url(&profile.base_url)?;
    if profile.capabilities.multi_image && !profile.capabilities.vision {
        return Err(config_error());
    }
    if profile.capabilities.realtime {
        return Err(config_error());
    }
    let c = &profile.capabilities;
    let supported = match profile.adapter_type.as_str() {
        "openai-compatible" | "anthropic" => {
            c.text_input && c.text_output && !c.native_audio_input && !c.native_audio_output
        }
        "openai-transcription" => {
            !c.text_input
                && c.text_output
                && c.native_audio_input
                && !c.native_audio_output
                && !c.vision
                && !c.multi_image
                && !c.streaming
        }
        "openai-speech" => {
            c.text_input
                && !c.text_output
                && !c.native_audio_input
                && c.native_audio_output
                && !c.vision
                && !c.multi_image
                && !c.streaming
        }
        _ => false,
    };
    if !supported {
        return Err(config_error());
    }
    Ok(())
}
#[tauri::command]
pub fn ai_profiles_list(state: State<'_, ProviderState>) -> Result<Vec<Profile>> {
    let profiles = state.profiles.lock().map_err(|_| config_error())?;
    // Preserve the original file instead of silently overwriting unknown future data.
    if profiles.load_failed && profiles.values.is_empty() {
        return Err(error(
            "PROVIDER_STORAGE",
            "Saved provider settings need attention. The original file has been preserved.",
        ));
    }
    Ok(profiles.values.clone())
}
#[tauri::command]
pub fn ai_profile_save(state: State<'_, ProviderState>, mut profile: Profile) -> Result<()> {
    profile.base_url = transport::base_url(&profile.base_url)?
        .to_string()
        .trim_end_matches('/')
        .to_owned();
    validate_profile(&profile)?;
    let mut profiles = state.profiles.lock().map_err(|_| config_error())?;
    if profiles.load_failed {
        return Err(error(
            "PROVIDER_STORAGE",
            "Saved provider settings need attention. The original file has been preserved.",
        ));
    }
    let mut next = profiles.values.clone();
    if let Some(old) = next.iter_mut().find(|item| item.id == profile.id) {
        if old.base_url != profile.base_url
            || old.adapter_type != profile.adapter_type
            || old.auth != profile.auth
        {
            return Err(error(
                "PROVIDER_ENDPOINT_BOUND",
                "Create a new profile when changing its endpoint or authentication.",
            ));
        }
        state.cancel_profile(&profile.id);
        *old = profile;
    } else {
        if next.len() >= 32 {
            return Err(error(
                "PROVIDER_LIMIT",
                "Remove a provider profile before adding another.",
            ));
        }
        next.push(profile);
    }
    state.persist(&next)?;
    profiles.values = next;
    Ok(())
}
#[tauri::command]
pub fn ai_profile_delete(state: State<'_, ProviderState>, profile_id: String) -> Result<()> {
    let mut profiles = state.profiles.lock().map_err(|_| config_error())?;
    if profiles.load_failed {
        return Err(config_error());
    }
    let mut next = profiles.values.clone();
    next.retain(|p| p.id != profile_id);
    state.cancel_profile(&profile_id);
    delete_secret(&profile_id)?;
    state.persist(&next)?;
    profiles.values = next;
    Ok(())
}
#[cfg(windows)]
fn secret_entry(id: &str) -> Result<keyring::Entry> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(config_error());
    }
    keyring::Entry::new("com.aidesktop.companion.providers", id).map_err(|_| credential_error())
}
fn credential_error() -> ProviderError {
    error(
        "PROVIDER_CREDENTIAL",
        "Check the profile's key in Windows Credential Manager.",
    )
}
#[cfg(windows)]
fn load_secret(id: &str) -> Result<Option<Zeroizing<String>>> {
    match secret_entry(id)?.get_password() {
        Ok(secret) => Ok(Some(Zeroizing::new(secret))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(credential_error()),
    }
}
#[cfg(not(windows))]
fn load_secret(_: &str) -> Result<Option<Zeroizing<String>>> {
    Err(credential_error())
}
#[cfg(windows)]
fn delete_secret(id: &str) -> Result<()> {
    match secret_entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(credential_error()),
    }
}
#[cfg(not(windows))]
fn delete_secret(_: &str) -> Result<()> {
    Err(credential_error())
}
#[tauri::command]
pub fn ai_profile_has_key(state: State<'_, ProviderState>, profile_id: String) -> Result<bool> {
    state.profile(&profile_id)?;
    Ok(load_secret(&profile_id)?.is_some())
}
#[tauri::command]
pub fn ai_profile_save_key(
    state: State<'_, ProviderState>,
    profile_id: String,
    secret: String,
) -> Result<()> {
    let secret = Zeroizing::new(secret);
    let profiles = state.profiles.lock().map_err(|_| config_error())?;
    if !profiles
        .values
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        return Err(config_error());
    }
    if secret.trim().is_empty() || secret.len() > 4096 || secret.chars().any(char::is_control) {
        return Err(credential_error());
    }
    state.cancel_profile(&profile_id);
    #[cfg(windows)]
    {
        secret_entry(&profile_id)?
            .set_password(secret.trim())
            .map_err(|_| credential_error())
    }
    #[cfg(not(windows))]
    {
        Err(credential_error())
    }
}
#[tauri::command]
pub fn ai_profile_delete_key(state: State<'_, ProviderState>, profile_id: String) -> Result<()> {
    let profiles = state.profiles.lock().map_err(|_| config_error())?;
    if !profiles
        .values
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        return Err(config_error());
    }
    state.cancel_profile(&profile_id);
    delete_secret(&profile_id)
}
#[tauri::command]
pub fn ai_cancel(state: State<'_, ProviderState>, request_id: String) -> Result<()> {
    if request_id.len() > 128 {
        return Err(config_error());
    }
    let mut jobs = state.jobs.lock().map_err(|_| config_error())?;
    if let Some(job) = jobs.active.get(&request_id) {
        let _ = job.cancel.send(true);
    }
    if jobs.cancelled.len() >= 64 {
        jobs.cancelled.pop_front();
    }
    jobs.cancelled.push_back(request_id);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDiagnostics {
    active_requests: usize,
    profile_count: usize,
}
#[tauri::command]
pub fn ai_provider_diagnostics(state: State<'_, ProviderState>) -> Result<ProviderDiagnostics> {
    let profile_count = state
        .profiles
        .lock()
        .map_err(|_| config_error())?
        .values
        .len();
    let active_requests = state.jobs.lock().map_err(|_| config_error())?.active.len();
    Ok(ProviderDiagnostics {
        active_requests,
        profile_count,
    })
}
