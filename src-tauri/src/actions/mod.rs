//! Application-owned actions. JEV classifies text; only policy-authorized fixed targets
//! reach the executor. This module has no visual, memory, or reasoning-provider dependency.
mod client;
mod executor;
use client::{ActionIntentEngine, Choice};
pub(crate) use client::{MODEL, TIMEOUT_MS};
use executor::{ActionExecutor, ExecutionPlan, Executor};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

// Promotion requires measured classifier/holdout/false-action and policy acceptance.
// Deliberately not a setting or an editable acceptance-artifact flag.
const REAL_EXECUTION_ACCEPTED: bool = false;
const CANDIDATE_LIFETIME: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Failure {
    #[serde(rename = "ACTION_UNAVAILABLE")]
    Unavailable,
    #[serde(rename = "ACTION_UNSUPPORTED")]
    Unsupported,
    #[serde(rename = "ACTION_DENIED")]
    Denied,
    #[serde(rename = "ACTION_CANCELLED")]
    Cancelled,
    #[serde(rename = "ACTION_INVALID_REFERENCE")]
    InvalidReference,
    #[serde(rename = "ACTION_TARGET_NOT_FOUND")]
    TargetNotFound,
    #[serde(rename = "ACTION_EXECUTION_FAILED")]
    ExecutionFailed,
    #[serde(rename = "ACTION_INTENT_UNAVAILABLE")]
    IntentUnavailable,
    #[serde(rename = "ACTION_INTENT_TIMEOUT")]
    IntentTimeout,
    #[serde(rename = "ACTION_INTENT_AUTH")]
    IntentAuth,
    #[serde(rename = "ACTION_INTENT_PROTOCOL")]
    IntentProtocol,
    #[serde(rename = "ACTION_INTENT_INVALID")]
    IntentInvalid,
}
pub type Result<T> = std::result::Result<T, Failure>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    Notepad,
    Calculator,
    CommandPrompt,
    Powershell,
    VisualStudioCode,
    VisualStudio,
    SyntheticCommand,
    SyntheticScript,
}
#[derive(Deserialize)]
struct Spec {
    targets: Vec<AllowedTarget>,
}
#[derive(Deserialize)]
struct AllowedTarget {
    id: Target,
    phrases: Vec<String>,
}
fn binding(text: &str) -> Option<Target> {
    if text.len() > 8192 {
        return None;
    }
    static SPEC: OnceLock<Spec> = OnceLock::new();
    let spec = SPEC.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../src/providers/realtime/actions/action-spec.json"
        ))
        .expect("checked-in action specification")
    });
    let normalized = text
        .trim()
        .trim_end_matches(['.', '!', '?'])
        .trim()
        .replace('’', "'")
        .replace('İ', "i")
        .to_lowercase();
    spec.targets
        .iter()
        .find(|entry| entry.phrases.contains(&normalized))
        .map(|entry| entry.id)
}

struct ActionPolicy;
impl ActionPolicy {
    fn authorize(target: Target, intent: Choice) -> Result<Target> {
        let required = match target {
            Target::Notepad => Choice::LaunchNotepad,
            Target::Calculator => Choice::LaunchCalculator,
            Target::CommandPrompt => Choice::OpenCommandPrompt,
            Target::Powershell => Choice::OpenPowershell,
            Target::VisualStudioCode => Choice::LaunchVisualStudioCode,
            Target::VisualStudio => Choice::LaunchVisualStudio,
            Target::SyntheticCommand => Choice::RunSyntheticCommand,
            Target::SyntheticScript => Choice::RunSyntheticScript,
        };
        if required == intent {
            Ok(target)
        } else {
            Err(Failure::Denied)
        }
    }
}

struct Candidate {
    target: Target,
    created: Instant,
    proposal: Option<Proposal>,
    plan: Option<ExecutionPlan>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    id: String,
    digest: String,
    epoch: u64,
    turn_id: String,
    kind: &'static str,
    target: Target,
    executable: String,
    executable_sha256: String,
    args: Vec<String>,
    working_directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    expires_at_unix_ms: u64,
}
impl Proposal {
    fn from_plan(plan: &ExecutionPlan, epoch: u64, turn_id: String) -> Result<Self> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Failure::InvalidReference)?;
        let mut proposal = Self {
            id: uuid::Uuid::new_v4().to_string(),
            digest: String::new(),
            epoch,
            turn_id,
            kind: match plan.target {
                Target::SyntheticCommand => "command",
                Target::SyntheticScript => "script",
                Target::CommandPrompt | Target::Powershell => "terminal",
                _ => "application",
            },
            target: plan.target,
            executable: plan.executable.to_string_lossy().into_owned(),
            executable_sha256: plan.executable_sha256.clone(),
            args: plan.args.clone(),
            working_directory: plan.working_directory.to_string_lossy().into_owned(),
            content: plan.content.clone(),
            expires_at_unix_ms: (now + CANDIDATE_LIFETIME).as_millis() as u64,
        };
        proposal.digest = proposal.calculate_digest()?;
        Ok(proposal)
    }
    fn calculate_digest(&self) -> Result<String> {
        let mut unsigned = self.clone();
        unsigned.digest.clear();
        let bytes = serde_json::to_vec(&unsigned).map_err(|_| Failure::InvalidReference)?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
    fn matches_plan(&self, plan: &ExecutionPlan) -> bool {
        self.target == plan.target
            && self.executable == plan.executable.to_string_lossy()
            && self.executable_sha256 == plan.executable_sha256
            && self.args == plan.args
            && self.working_directory == plan.working_directory.to_string_lossy()
            && self.content == plan.content
    }
}
#[derive(Default)]
struct Slot {
    enabled: bool,
    epoch: u64,
    turn_id: String,
    used: bool,
    pending: Option<Candidate>,
    abort: Option<Box<dyn Fn() + Send + Sync>>,
}
impl Slot {
    fn invalidate(&mut self) {
        if let Some(abort) = self.abort.take() {
            abort();
        }
        self.epoch = self.epoch.wrapping_add(1);
        self.turn_id.clear();
        self.used = false;
        self.pending = None;
    }
    fn validate(&self, epoch: u64) -> Result<()> {
        if !self.enabled || epoch != self.epoch || self.turn_id.is_empty() {
            return Err(Failure::Cancelled);
        }
        Ok(())
    }
}
#[derive(Default)]
pub struct Runtime {
    slot: Arc<Mutex<Slot>>,
    engine: OnceLock<ActionIntentEngine>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    execution_available: bool,
    pending_candidates: usize,
    generation: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    handled: bool,
    code: &'static str,
    target: Option<Target>,
    turn_id: String,
    candidate: Option<Proposal>,
}
impl Runtime {
    pub fn status(&self) -> Status {
        let slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        Status {
            enabled: slot.enabled,
            execution_available: REAL_EXECUTION_ACCEPTED,
            pending_candidates: usize::from(slot.pending.is_some()),
            generation: slot.epoch,
        }
    }
    pub fn configure(&self, enabled: bool) -> Status {
        {
            let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
            slot.invalidate();
            slot.enabled = enabled;
        }
        self.status()
    }
    pub fn cancel(&self, epoch: Option<u64>) {
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        if epoch.is_none_or(|value| value == slot.epoch) {
            slot.invalidate();
        }
    }
    pub fn begin(&self, turn_id: String) -> Result<u64> {
        if turn_id.is_empty() || turn_id.len() > 128 || turn_id.chars().any(char::is_control) {
            return Err(Failure::InvalidReference);
        }
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        if !slot.enabled {
            return Err(Failure::Unavailable);
        }
        slot.invalidate();
        slot.turn_id = turn_id;
        Ok(slot.epoch)
    }
    fn reserve(&self, epoch: u64, text: &str) -> Result<Target> {
        let target = binding(text).ok_or(Failure::Unsupported)?;
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        slot.validate(epoch)?;
        if slot.used {
            return Err(Failure::Cancelled);
        }
        slot.used = true;
        slot.pending = Some(Candidate {
            target,
            created: Instant::now(),
            proposal: None,
            plan: None,
        });
        Ok(target)
    }
    fn propose(
        &self,
        epoch: u64,
        target: Target,
        intent: Choice,
        executor: &dyn Executor,
    ) -> Result<Outcome> {
        // Classification only constructs a candidate; it never invokes execute.
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        slot.validate(epoch)?;
        slot.abort = None;
        let mut candidate = slot.pending.take().ok_or(Failure::Cancelled)?;
        if candidate.created.elapsed() > CANDIDATE_LIFETIME
            || candidate.target != target
            || candidate.proposal.is_some()
        {
            return Err(Failure::InvalidReference);
        }
        let turn_id = slot.turn_id.clone();
        if ActionPolicy::authorize(candidate.target, intent).is_err() {
            return Ok(Outcome {
                handled: true,
                code: "ACTION_DENIED",
                target: Some(target),
                turn_id,
                candidate: None,
            });
        }
        let plan = executor.prepare(target)?;
        plan.validate()?;
        if plan.target != target {
            return Err(Failure::InvalidReference);
        }
        let proposal = Proposal::from_plan(&plan, epoch, turn_id.clone())?;
        candidate.created = Instant::now();
        candidate.proposal = Some(proposal.clone());
        candidate.plan = Some(plan);
        slot.pending = Some(candidate);
        Ok(Outcome {
            handled: true,
            code: "ACTION_CONFIRMATION_REQUIRED",
            target: Some(target),
            turn_id,
            candidate: Some(proposal),
        })
    }
    fn confirm(
        &self,
        epoch: u64,
        turn_id: &str,
        candidate_id: &str,
        digest: &str,
        executor: &dyn Executor,
        release_accepted: bool,
    ) -> Result<Outcome> {
        // This same lock fences cancellation, configuration/key revocation, and process
        // creation. Confirmation consumes the stored candidate even when it is invalid.
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        slot.validate(epoch)?;
        let candidate = slot.pending.take().ok_or(Failure::Cancelled)?;
        let proposal = candidate.proposal.ok_or(Failure::InvalidReference)?;
        let plan = candidate.plan.ok_or(Failure::InvalidReference)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Failure::InvalidReference)?
            .as_millis() as u64;
        if candidate.created.elapsed() > CANDIDATE_LIFETIME
            || now > proposal.expires_at_unix_ms
            || epoch != proposal.epoch
            || turn_id != slot.turn_id
            || turn_id != proposal.turn_id
            || candidate_id != proposal.id
            || digest != proposal.digest
            || proposal.calculate_digest()? != proposal.digest
            || !proposal.matches_plan(&plan)
            || candidate.target != plan.target
        {
            return Err(Failure::InvalidReference);
        }
        plan.validate()?;
        let code = if !release_accepted {
            "ACTION_RELEASE_GATE"
        } else {
            match executor.execute(&plan) {
                Ok(()) => "ACTION_STARTED",
                Err(Failure::TargetNotFound) => "ACTION_TARGET_NOT_FOUND",
                Err(Failure::InvalidReference) => "ACTION_INVALID_REFERENCE",
                Err(_) => "ACTION_EXECUTION_FAILED",
            }
        };
        Ok(Outcome {
            handled: true,
            code,
            target: Some(candidate.target),
            turn_id: turn_id.into(),
            candidate: None,
        })
    }
    fn reject(&self, epoch: u64, turn_id: &str, candidate_id: &str, digest: &str) -> Result<()> {
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        slot.validate(epoch)?;
        let proposal = slot
            .pending
            .as_ref()
            .and_then(|candidate| candidate.proposal.as_ref())
            .ok_or(Failure::Cancelled)?;
        if turn_id != slot.turn_id || candidate_id != proposal.id || digest != proposal.digest {
            return Err(Failure::InvalidReference);
        }
        slot.invalidate();
        Ok(())
    }
    fn prepare_engine(
        &self,
        epoch: u64,
        initialize: impl FnOnce() -> Result<ActionIntentEngine>,
    ) -> Result<ActionIntentEngine> {
        if let Some(engine) = self.engine.get() {
            return Ok(engine.clone());
        }
        match initialize() {
            Ok(engine) => {
                let _ = self.engine.set(engine.clone());
                Ok(engine)
            }
            Err(error) => {
                self.cancel(Some(epoch));
                Err(error)
            }
        }
    }
    async fn classify(self: &Arc<Self>, epoch: u64, text: String) -> Result<Outcome> {
        let target = self.reserve(epoch, &text)?;
        let engine = self.prepare_engine(epoch, ActionIntentEngine::new)?;
        let runtime = self.clone();
        let task = {
            let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
            slot.validate(epoch)?;
            let task = tauri::async_runtime::spawn(async move {
                let text = zeroize::Zeroizing::new(text);
                let key = tauri::async_runtime::spawn_blocking(crate::voice::load_jev_key)
                    .await
                    .map_err(|_| Failure::IntentAuth)?
                    .map_err(|_| Failure::IntentAuth)?
                    .ok_or(Failure::IntentUnavailable)?;
                runtime
                    .slot
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .validate(epoch)?;
                engine.classify(&key, &text).await
            });
            let abort = task.inner().abort_handle();
            slot.abort = Some(Box::new(move || abort.abort()));
            task
        };
        let decision = task.await.unwrap_or(Err(Failure::Cancelled));
        let decision = match decision {
            Ok(value) => value,
            Err(error) => {
                self.cancel(Some(epoch));
                return Err(error);
            }
        };
        let runtime = self.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            runtime.propose(epoch, target, decision, &ActionExecutor)
        })
        .await
        {
            Ok(result) => result,
            Err(_) => {
                self.cancel(Some(epoch));
                Err(Failure::ExecutionFailed)
            }
        }
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.cancel(None);
    }
}

#[tauri::command]
pub fn actions_configure(
    state: tauri::State<'_, crate::commands::AppState>,
    enabled: bool,
) -> Status {
    state.4.configure(enabled)
}
#[tauri::command]
pub fn actions_begin(
    state: tauri::State<'_, crate::commands::AppState>,
    turn_id: String,
) -> Result<u64> {
    state.4.begin(turn_id)
}
#[tauri::command]
pub fn actions_cancel(state: tauri::State<'_, crate::commands::AppState>, epoch: Option<u64>) {
    state.4.cancel(epoch);
}
#[tauri::command]
pub fn actions_status(state: tauri::State<'_, crate::commands::AppState>) -> Status {
    state.4.status()
}
#[tauri::command]
pub async fn actions_classify(
    state: tauri::State<'_, crate::commands::AppState>,
    epoch: u64,
    text: String,
) -> Result<Outcome> {
    state.4.classify(epoch, text).await
}
#[tauri::command]
pub async fn actions_confirm(
    state: tauri::State<'_, crate::commands::AppState>,
    epoch: u64,
    turn_id: String,
    candidate_id: String,
    digest: String,
) -> Result<Outcome> {
    let runtime = state.4.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.confirm(
            epoch,
            &turn_id,
            &candidate_id,
            &digest,
            &ActionExecutor,
            REAL_EXECUTION_ACCEPTED,
        )
    })
    .await
    .map_err(|_| Failure::ExecutionFailed)?
}
#[tauri::command]
pub fn actions_reject(
    state: tauri::State<'_, crate::commands::AppState>,
    epoch: u64,
    turn_id: String,
    candidate_id: String,
    digest: String,
) -> Result<()> {
    state.4.reject(epoch, &turn_id, &candidate_id, &digest)
}
