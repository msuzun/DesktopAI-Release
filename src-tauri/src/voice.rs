use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use zeroize::Zeroizing;

const STORE_ERROR: &str =
    "Secure credential storage unavailable. Check Windows Credential Manager.";
#[cfg(windows)]
static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub trait SecretStore {
    fn save(&self, provider: &str, secret: &str) -> Result<(), String>;
    fn load(&self, provider: &str) -> Result<Option<Zeroizing<String>>, String>;
    fn delete(&self, provider: &str) -> Result<(), String>;
}
struct OsSecretStore;
#[cfg(windows)]
fn entry(provider: &str) -> Result<keyring::Entry, String> {
    if provider != "jev" {
        definition(provider)?;
    }
    keyring::Entry::new("com.aidesktop.companion.voice", provider).map_err(|_| STORE_ERROR.into())
}

// JEV is an action-intent credential, never a visual router or voice provider.
pub(crate) fn load_jev_key() -> Result<Option<Zeroizing<String>>, String> {
    for name in ["JEV_API_KEY", "TYPESAFE_API_KEY"] {
        if let Ok(value) = std::env::var(name) {
            let value = Zeroizing::new(value);
            if !value.trim().is_empty() && value.len() <= 4096 {
                return Ok(Some(Zeroizing::new(value.trim().to_owned())));
            }
        }
    }
    OsSecretStore.load("jev")
}
#[cfg(windows)]
impl SecretStore for OsSecretStore {
    fn save(&self, provider: &str, secret: &str) -> Result<(), String> {
        let _guard = STORE_LOCK.lock().map_err(|_| STORE_ERROR.to_string())?;
        entry(provider)?
            .set_password(secret)
            .map_err(|_| STORE_ERROR.into())
    }
    fn load(&self, provider: &str) -> Result<Option<Zeroizing<String>>, String> {
        let _guard = STORE_LOCK.lock().map_err(|_| STORE_ERROR.to_string())?;
        match entry(provider)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(STORE_ERROR.into()),
        }
    }
    fn delete(&self, provider: &str) -> Result<(), String> {
        let _guard = STORE_LOCK.lock().map_err(|_| STORE_ERROR.to_string())?;
        match entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(STORE_ERROR.into()),
        }
    }
}
#[cfg(not(windows))]
impl SecretStore for OsSecretStore {
    fn save(&self, _: &str, _: &str) -> Result<(), String> {
        Err(STORE_ERROR.into())
    }
    fn load(&self, _: &str) -> Result<Option<Zeroizing<String>>, String> {
        Err(STORE_ERROR.into())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Err(STORE_ERROR.into())
    }
}
fn catalog() -> Value {
    serde_json::from_str(include_str!("../../src/providers/realtime/catalog.json"))
        .expect("compiled provider catalog")
}
fn definition(provider: &str) -> Result<Value, String> {
    catalog()["providers"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["id"] == provider))
        .cloned()
        .ok_or_else(|| "Unsupported provider.".into())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    provider_id: String,
    model: String,
    voice: String,
}
fn validate(config: &SessionConfig) -> Result<(), String> {
    let def = definition(&config.provider_id)?;
    if !def["models"]
        .as_array()
        .unwrap()
        .contains(&json!(config.model))
        || !def["voices"]
            .as_array()
            .unwrap()
            .contains(&json!(config.voice))
    {
        return Err("Unsupported model or voice.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn save_voice_key(provider: String, secret: String) -> Result<(), String> {
    let secret = Zeroizing::new(secret);
    if secret.trim().is_empty() || secret.len() > 4096 {
        return Err("Enter a valid API key.".into());
    }
    tauri::async_runtime::spawn_blocking(move || OsSecretStore.save(&provider, secret.trim()))
        .await
        .map_err(|_| STORE_ERROR.to_string())?
}
#[tauri::command]
pub async fn has_voice_key(provider: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        OsSecretStore.load(&provider).map(|value| value.is_some())
    })
    .await
    .map_err(|_| STORE_ERROR.to_string())?
}
#[tauri::command]
pub async fn delete_voice_key(provider: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || OsSecretStore.delete(&provider))
        .await
        .map_err(|_| STORE_ERROR.to_string())?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredential {
    kind: &'static str,
    value: String,
    model: String,
}
#[tauri::command]
pub async fn voice_credential(config: SessionConfig) -> Result<ProviderCredential, String> {
    validate(&config)?;
    let provider = config.provider_id.clone();
    let key = tauri::async_runtime::spawn_blocking(move || OsSecretStore.load(&provider))
        .await
        .map_err(|_| STORE_ERROR.to_string())??
        .ok_or("No saved API key. Save a key in AI settings first.")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Network initialization failed.")?;
    let request = match config.provider_id.as_str() {
        "openai" => client.post("https://api.openai.com/v1/realtime/client_secrets").bearer_auth(key.as_str()).json(&json!({
            "expires_after":{"anchor":"created_at","seconds":60},
            "session":{"type":"realtime","model":config.model,"instructions":catalog()["instructions"],"output_modalities":["audio"],
                "tools":[],"tool_choice":"none",
                "audio":{"input":{"transcription":{"model":"gpt-4o-mini-transcribe"},"turn_detection":{"type":"server_vad","create_response":true,"interrupt_response":true}},"output":{"voice":config.voice}}}
        })),
        "gemini" => client.post("https://generativelanguage.googleapis.com/v1beta/auth_tokens").header("x-goog-api-key", key.as_str()).json(&json!({"uses":1})),
        _ => return Err("Unsupported provider.".into()),
    };
    let response = request
        .send()
        .await
        .map_err(|error| network_error(&error))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(match status {
            401 | 403 => "API key rejected or model access denied. Check key permissions.",
            400 | 404 => "Provider rejected the key, model or configuration. Check API access.",
            429 => "Provider quota or rate limit reached. Check API billing.",
            _ => "Provider unavailable. Try again later.",
        }
        .into());
    }
    let data: Value = response
        .json()
        .await
        .map_err(|_| "Invalid credential response.")?;
    let field = if config.provider_id == "openai" {
        "value"
    } else {
        "name"
    };
    let value = data[field]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Invalid credential response.")?
        .to_owned();
    Ok(ProviderCredential {
        kind: "ephemeral",
        value,
        model: config.model,
    })
}

fn network_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        return "Provider connection timed out. Check your network and try again.";
    }
    // Inspect causes only to select fixed, safe text. Never return URLs, proxy
    // configuration, request headers, or raw provider/transport error payloads.
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = cause {
        let message = current.to_string().to_ascii_lowercase();
        if message.contains("certificate") || message.contains("unknownissuer") {
            return "Provider TLS certificate could not be verified. Check Windows certificate trust and any HTTPS-inspecting proxy.";
        }
        if message.contains("dns") || message.contains("resolve") {
            return "Provider address could not be resolved. Check your DNS, VPN, and network connection.";
        }
        cause = current.source();
    }
    "Provider network connection failed. Check your network, proxy, and firewall."
}
