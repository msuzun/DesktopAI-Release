use serde::{Deserialize, Serialize};

pub const MAX_UTTERANCE_BYTES: usize = 8192;
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Availability {
    pub screen_awareness_enabled: bool,
    pub current_available: bool,
    pub recent_available: bool,
    pub previous_reference_available: bool,
}
// Deliberately closed: no images, OCR, titles, conversation history or file data.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub user_utterance: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_turn_context: Option<String>,
    pub visual_availability: Availability,
}
impl Input {
    pub fn validate(&self) -> Result<()> {
        if self.user_utterance.trim().is_empty()
            || self.user_utterance.len() > MAX_UTTERANCE_BYTES
            || self
                .previous_turn_context
                .as_ref()
                .is_some_and(|s| s.len() > 1024)
        {
            return Err(Failure::InvalidInput);
        }
        if !self.visual_availability.screen_awareness_enabled {
            return Err(Failure::Privacy);
        }
        Ok(())
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.user_utterance.zeroize();
        self.previous_turn_context.zeroize();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    NotConfigured,
    CredentialStore,
    Authentication,
    RateLimit,
    Transport,
    Timeout,
    ServiceUnavailable,
    InvalidInput,
    InvalidResult,
    Cancelled,
    Privacy,
    Busy,
    ModelMissing,
    RuntimeMissing,
    LoadFailed,
    UnsupportedDevice,
    OutOfMemory,
    InferenceFailed,
    WorkerExited,
}
pub type Result<T> = std::result::Result<T, Failure>;
