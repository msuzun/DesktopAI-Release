use super::*;

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{Client, Response, Url};
use serde_json::{json, Value};
use std::{future::Future, time::Duration};
use tauri::ipc::Channel;

const MAX_TEXT: usize = 64 * 1024;
const MAX_IMAGE: usize = 5 * 1024 * 1024;
const MAX_REQUEST: usize = 16 * 1024 * 1024;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_AUDIO: usize = 4 * 1024 * 1024;
const MAX_FRAME: usize = 128 * 1024;

pub(super) fn base_url(value: &str) -> Result<Url> {
    if value.len() > 2048
        || value.trim() != value
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err(config_error());
    }
    let mut url = Url::parse(value).map_err(|_| config_error())?;
    let host = url.host_str().ok_or_else(config_error)?;
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !matches!(url.scheme(), "https" | "http")
        || (url.scheme() == "http" && !loopback)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(config_error());
    }
    let path = url.path().trim_end_matches('/');
    if path.ends_with("/chat/completions")
        || path.ends_with("/messages")
        || path.ends_with("/audio/transcriptions")
        || path.ends_with("/audio/speech")
        || path.contains('%')
        || path.contains("//")
    {
        return Err(config_error());
    }
    let normalized = format!("{path}/");
    url.set_path(&normalized);
    Ok(url)
}
fn endpoint(profile: &Profile, path: &str) -> Result<Url> {
    base_url(&profile.base_url)?
        .join(path)
        .map_err(|_| config_error())
}
fn client() -> Result<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| error("PROVIDER_NETWORK", "Network initialization failed."))
}
fn network_error(err: reqwest::Error) -> ProviderError {
    if err.is_timeout() {
        return error("PROVIDER_TIMEOUT", "The provider did not respond in time.");
    }
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(&err);
    while let Some(source) = cause {
        let message = source.to_string().to_ascii_lowercase();
        if message.contains("certificate") || message.contains("unknownissuer") {
            return error(
                "PROVIDER_TLS",
                "The provider's TLS certificate could not be verified.",
            );
        }
        cause = source.source();
    }
    error("PROVIDER_NETWORK", "The provider could not be reached.")
}
fn protocol() -> ProviderError {
    error(
        "PROVIDER_PROTOCOL",
        "The provider returned an invalid or incomplete response.",
    )
}
fn limit() -> ProviderError {
    error(
        "PROVIDER_LIMIT",
        "The provider request or response exceeded its size limit.",
    )
}
fn status(response: Response) -> Result<Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    Err(match response.status().as_u16() {
        401 | 403 => error(
            "PROVIDER_AUTH",
            "The provider rejected the credential or model access.",
        ),
        429 => error(
            "PROVIDER_RATE_LIMIT",
            "The provider's quota or rate limit was reached.",
        ),
        300..=399 => error(
            "PROVIDER_REDIRECT",
            "Provider redirects are disabled to protect credentials.",
        ),
        400 | 404 | 422 => error(
            "PROVIDER_CONFIG",
            "The provider rejected the model or request configuration.",
        ),
        _ => error(
            "PROVIDER_UNAVAILABLE",
            "The provider is currently unavailable.",
        ),
    })
}
async fn bounded(mut response: Response, maximum: usize) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|size| size > maximum as u64)
    {
        return Err(limit());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > maximum {
            return Err(limit());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn authenticate(
    builder: reqwest::RequestBuilder,
    profile: &Profile,
    key: Option<&str>,
) -> Result<reqwest::RequestBuilder> {
    let builder = if profile.adapter_type == "anthropic" {
        builder.header("anthropic-version", "2023-06-01")
    } else {
        builder
    };
    if profile.auth == "none" {
        return Ok(builder);
    }
    let key = key.filter(|key| !key.is_empty()).ok_or_else(|| {
        error(
            "PROVIDER_AUTH",
            "Save a credential for this provider profile.",
        )
    })?;
    Ok(if profile.adapter_type == "anthropic" {
        builder.header("x-api-key", key)
    } else {
        builder.bearer_auth(key)
    })
}
async fn execute<T>(
    state: &ProviderState,
    request_id: &str,
    profile: &Profile,
    operation: impl Future<Output = Result<T>>,
) -> Result<T> {
    let mut cancel = {
        let profiles = state.profiles.lock().map_err(|_| config_error())?;
        if !profiles.values.iter().any(|current| current == profile) {
            return Err(cancelled());
        }
        state.begin(request_id, &profile.id)?
    };
    struct RequestGuard<'a> {
        state: &'a ProviderState,
        id: &'a str,
    }
    impl Drop for RequestGuard<'_> {
        fn drop(&mut self) {
            self.state.finish(self.id);
        }
    }
    let _guard = RequestGuard {
        state,
        id: request_id,
    };
    // Holding the receiver makes explicit cancellation drop the HTTP future immediately.
    let result = tokio::select! {
        biased;
        _ = cancel.changed() => Err(cancelled()),
        result = tokio::time::timeout(Duration::from_secs(65), operation) => result.unwrap_or_else(|_| Err(error("PROVIDER_TIMEOUT", "The provider did not respond in time."))),
    };
    result
}
async fn key(profile: &Profile) -> Result<Option<Zeroizing<String>>> {
    if profile.auth == "none" {
        return Ok(None);
    }
    let id = profile.id.clone();
    tauri::async_runtime::spawn_blocking(move || load_secret(&id))
        .await
        .map_err(|_| credential_error())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct History {
    role: String,
    text: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Image {
    mime_type: String,
    base64: String,
    label: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionRequest {
    request_id: String,
    profile_id: String,
    system: String,
    messages: Vec<History>,
    text: String,
    images: Vec<Image>,
    stream: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEvent {
    request_id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}
#[derive(Serialize)]
pub struct TextResult {
    text: String,
}
fn completion_body(profile: &Profile, request: &CompletionRequest) -> Result<Value> {
    if !matches!(
        profile.adapter_type.as_str(),
        "openai-compatible" | "anthropic"
    ) || !profile.capabilities.text_input
        || !profile.capabilities.text_output
    {
        return Err(error(
            "PROVIDER_CAPABILITY",
            "This profile does not support text conversation.",
        ));
    }
    if request.images.len() > 4
        || (!request.images.is_empty() && !profile.capabilities.vision)
        || (request.images.len() > 1 && !profile.capabilities.multi_image)
    {
        return Err(error(
            "PROVIDER_CAPABILITY",
            "This provider does not support the selected visual context.",
        ));
    }
    if request.stream && !profile.capabilities.streaming {
        return Err(error(
            "PROVIDER_CAPABILITY",
            "This provider does not support streaming.",
        ));
    }
    if request.text.trim().is_empty()
        || request.text.len() > MAX_TEXT
        || request.system.len() > MAX_TEXT
        || request.messages.len() > 40
    {
        return Err(limit());
    }
    let anthropic = profile.adapter_type == "anthropic";
    let mut messages = Vec::new();
    if !anthropic && !request.system.is_empty() {
        messages.push(json!({"role":"system","content":request.system}));
    }
    let mut text_bytes = request.text.len() + request.system.len();
    for message in &request.messages {
        if !matches!(message.role.as_str(), "user" | "assistant") {
            return Err(config_error());
        }
        text_bytes += message.text.len();
        if text_bytes > 128 * 1024 {
            return Err(limit());
        }
        messages.push(json!({"role":message.role,"content":message.text}));
    }
    let mut content = vec![json!({"type":"text","text":request.text})];
    for image in &request.images {
        if !matches!(
            image.mime_type.as_str(),
            "image/jpeg" | "image/png" | "image/webp"
        ) || image.label.len() > 2000
            || image.base64.len() > MAX_IMAGE * 4 / 3 + 4
        {
            return Err(limit());
        }
        let decoded = STANDARD.decode(&image.base64).map_err(|_| config_error())?;
        if decoded.is_empty() || decoded.len() > MAX_IMAGE {
            return Err(limit());
        }
        content.push(json!({"type":"text","text":image.label}));
        content.push(if anthropic {
            json!({"type":"image","source":{"type":"base64","media_type":image.mime_type,"data":image.base64}})
        } else {
            json!({"type":"image_url","image_url":{"url":format!("data:{};base64,{}",image.mime_type,image.base64)}})
        });
    }
    messages.push(json!({"role":"user","content":content}));
    let mut body = json!({"model":profile.model,"messages":messages,"stream":request.stream});
    if anthropic {
        body["system"] = json!(request.system);
        body["max_tokens"] = json!(2048);
    }
    // Generic endpoints differ on max_tokens vs max_completion_tokens; bound locally.
    if serde_json::to_vec(&body).map_err(|_| config_error())?.len() > MAX_REQUEST {
        return Err(limit());
    }
    Ok(body)
}

#[derive(Default)]
struct Sse {
    pending: Vec<u8>,
    data: Vec<String>,
    event_bytes: usize,
    total: usize,
}
impl Sse {
    fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        self.total += bytes.len();
        if self.total > MAX_RESPONSE {
            return Err(limit());
        }
        self.pending.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(index) = self.pending.iter().position(|byte| *byte == b'\n') {
            if index > MAX_FRAME {
                return Err(limit());
            }
            let line: Vec<u8> = self.pending.drain(..=index).collect();
            let line = std::str::from_utf8(&line[..line.len() - 1])
                .map_err(|_| protocol())?
                .trim_end_matches('\r');
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                    self.event_bytes = 0;
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                let data = data.strip_prefix(' ').unwrap_or(data);
                self.event_bytes += data.len();
                if self.event_bytes > MAX_FRAME {
                    return Err(limit());
                }
                self.data.push(data.to_owned());
            }
        }
        if self.pending.len() > MAX_FRAME {
            return Err(limit());
        }
        Ok(events)
    }
}
fn stream_event(anthropic: bool, data: &str) -> Result<(Option<String>, bool)> {
    if !anthropic && data == "[DONE]" {
        return Ok((None, true));
    }
    let data: Value = serde_json::from_str(data).map_err(|_| protocol())?;
    if !data["error"].is_null() || data["type"] == "error" {
        return Err(error(
            "PROVIDER_STREAM",
            "The provider interrupted its response.",
        ));
    }
    if anthropic {
        return match data["type"].as_str() {
            Some("message_stop") => Ok((None, true)),
            Some("content_block_delta") if data["delta"]["type"] == "text_delta" => Ok((
                Some(
                    data["delta"]["text"]
                        .as_str()
                        .ok_or_else(protocol)?
                        .to_owned(),
                ),
                false,
            )),
            Some(
                "message_start"
                | "content_block_start"
                | "content_block_stop"
                | "message_delta"
                | "ping"
                | "content_block_delta",
            ) => Ok((None, false)),
            _ => Err(protocol()),
        };
    }
    if data["choices"]
        .as_array()
        .is_some_and(|choices| choices.is_empty())
    {
        return Ok((None, false));
    }
    let choice = data["choices"].get(0).ok_or_else(protocol)?;
    if choice["finish_reason"] == "content_filter" {
        return Err(error(
            "PROVIDER_REFUSAL",
            "The provider could not complete this response.",
        ));
    }
    if !choice["delta"]["tool_calls"].is_null() {
        return Err(error(
            "PROVIDER_CAPABILITY",
            "Unexpected provider tool request.",
        ));
    }
    let text = choice["delta"]["content"]
        .as_str()
        .or_else(|| choice["delta"]["refusal"].as_str())
        .map(str::to_owned);
    Ok((text, false))
}
async fn complete(
    profile: &Profile,
    request: &CompletionRequest,
    mut emit: impl FnMut(ResponseEvent) -> Result<()>,
) -> Result<TextResult> {
    let body = completion_body(profile, request)?;
    let key = key(profile).await?;
    let anthropic = profile.adapter_type == "anthropic";
    let mut response = status(
        authenticate(
            client()?
                .post(endpoint(
                    profile,
                    if anthropic {
                        "messages"
                    } else {
                        "chat/completions"
                    },
                )?)
                .json(&body),
            profile,
            key.as_ref().map(|key| key.as_str()),
        )?
        .send()
        .await
        .map_err(network_error)?,
    )?;
    let mut text = String::new();
    if request.stream {
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"))
        {
            return Err(protocol());
        }
        let mut parser = Sse::default();
        let mut completed = false;
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            for data in parser.feed(&chunk)? {
                let (delta, done) = stream_event(anthropic, &data)?;
                if let Some(delta) = delta {
                    if text.len() + delta.len() > MAX_TEXT {
                        return Err(limit());
                    }
                    text.push_str(&delta);
                    emit(ResponseEvent {
                        request_id: request.request_id.clone(),
                        kind: "text_delta",
                        text: Some(delta),
                    })?;
                }
                if done {
                    completed = true;
                    break;
                }
            }
            if completed {
                break;
            }
        }
        if !completed {
            return Err(protocol());
        }
    } else {
        let data: Value = serde_json::from_slice(&bounded(response, MAX_RESPONSE).await?)
            .map_err(|_| protocol())?;
        if !data["error"].is_null() {
            return Err(protocol());
        }
        if anthropic {
            for block in data["content"].as_array().ok_or_else(protocol)? {
                if block["type"] == "text" {
                    text.push_str(block["text"].as_str().ok_or_else(protocol)?);
                }
            }
        } else {
            let message = &data["choices"][0]["message"];
            text = message["content"]
                .as_str()
                .or_else(|| message["refusal"].as_str())
                .ok_or_else(protocol)?
                .to_owned();
        }
        if text.len() > MAX_TEXT {
            return Err(limit());
        }
        emit(ResponseEvent {
            request_id: request.request_id.clone(),
            kind: "text_delta",
            text: Some(text.clone()),
        })?;
    }
    if text.trim().is_empty() {
        return Err(protocol());
    }
    emit(ResponseEvent {
        request_id: request.request_id.clone(),
        kind: "completed",
        text: None,
    })?;
    Ok(TextResult { text })
}
#[tauri::command]
pub async fn ai_complete(
    state: State<'_, ProviderState>,
    request: CompletionRequest,
    on_event: Channel<ResponseEvent>,
) -> Result<TextResult> {
    let profile = state.profile(&request.profile_id)?;
    execute(
        &state,
        &request.request_id,
        &profile,
        complete(&profile, &request, |event| {
            on_event.send(event).map_err(|_| cancelled())
        }),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptionRequest {
    request_id: String,
    profile_id: String,
    audio_base64: String,
    mime_type: String,
    language: Option<String>,
}
async fn transcribe(profile: &Profile, request: &TranscriptionRequest) -> Result<TextResult> {
    if profile.adapter_type != "openai-transcription" || request.mime_type != "audio/wav" {
        return Err(config_error());
    }
    if request.audio_base64.len() > MAX_AUDIO * 4 / 3 + 4 {
        return Err(limit());
    }
    let audio = Zeroizing::new(
        STANDARD
            .decode(&request.audio_base64)
            .map_err(|_| config_error())?,
    );
    if audio.len() > MAX_AUDIO
        || audio.len() < 44
        || &audio[..4] != b"RIFF"
        || &audio[8..12] != b"WAVE"
    {
        return Err(config_error());
    }
    if request
        .language
        .as_ref()
        .is_some_and(|language| !matches!(language.as_str(), "tr" | "en"))
    {
        return Err(config_error());
    }
    let boundary = format!("companion-{}", uuid::Uuid::new_v4());
    let mut body = Zeroizing::new(Vec::new());
    let mut field = |name: &str, value: &str| {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    };
    field("model", &profile.model);
    field("response_format", "json");
    if let Some(language) = &request.language {
        field("language", language);
    }
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes());
    body.extend_from_slice(&audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let key = key(profile).await?;
    let response = status(
        authenticate(
            client()?
                .post(endpoint(profile, "audio/transcriptions")?)
                .header(
                    reqwest::header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(body.to_vec()),
            profile,
            key.as_ref().map(|key| key.as_str()),
        )?
        .send()
        .await
        .map_err(network_error)?,
    )?;
    let data: Value =
        serde_json::from_slice(&bounded(response, 256 * 1024).await?).map_err(|_| protocol())?;
    let text = data["text"].as_str().ok_or_else(protocol)?;
    if text.len() > MAX_TEXT {
        return Err(limit());
    }
    Ok(TextResult {
        text: text.to_owned(),
    })
}
#[tauri::command]
pub async fn ai_transcribe(
    state: State<'_, ProviderState>,
    request: TranscriptionRequest,
) -> Result<TextResult> {
    let profile = state.profile(&request.profile_id)?;
    execute(
        &state,
        &request.request_id,
        &profile,
        transcribe(&profile, &request),
    )
    .await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SynthesisRequest {
    request_id: String,
    profile_id: String,
    text: String,
    voice: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioResult {
    audio_base64: String,
    mime_type: &'static str,
    sample_rate: u32,
}
async fn synthesize(profile: &Profile, request: &SynthesisRequest) -> Result<AudioResult> {
    if profile.adapter_type != "openai-speech" {
        return Err(config_error());
    }
    if request.text.trim().is_empty() || request.text.chars().count() > 4000 {
        return Err(limit());
    }
    let voice = request
        .voice
        .as_ref()
        .or(profile.voice.as_ref())
        .ok_or_else(config_error)?;
    if voice.is_empty() || voice.len() > 100 || voice.chars().any(char::is_control) {
        return Err(config_error());
    }
    let body =
        json!({"model":profile.model,"input":request.text,"voice":voice,"response_format":"pcm"});
    let key = key(profile).await?;
    let response = status(
        authenticate(
            client()?
                .post(endpoint(profile, "audio/speech")?)
                .json(&body),
            profile,
            key.as_ref().map(|key| key.as_str()),
        )?
        .send()
        .await
        .map_err(network_error)?,
    )?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !["audio/pcm", "application/octet-stream"]
        .iter()
        .any(|allowed| content_type.to_ascii_lowercase().split(';').next() == Some(allowed))
    {
        return Err(protocol());
    }
    let audio = Zeroizing::new(bounded(response, MAX_AUDIO).await?);
    if audio.is_empty() || audio.len() % 2 != 0 {
        return Err(protocol());
    }
    Ok(AudioResult {
        audio_base64: STANDARD.encode(&audio),
        mime_type: "audio/pcm",
        sample_rate: 24000,
    })
}
#[tauri::command]
pub async fn ai_synthesize(
    state: State<'_, ProviderState>,
    request: SynthesisRequest,
) -> Result<AudioResult> {
    let profile = state.profile(&request.profile_id)?;
    execute(
        &state,
        &request.request_id,
        &profile,
        synthesize(&profile, &request),
    )
    .await
}
