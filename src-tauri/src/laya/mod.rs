//! Persistent local inference process. No image/capture types cross this module.
use crate::routing::contract::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const WORKER: &str = include_str!("../../../tools/laya/worker.py");
const MODEL_LOCK: &str = include_str!("../../../tools/laya/models.lock.json");
const SPEC: &str = include_str!("../../../src/providers/realtime/preflight/route-spec.json");
const COMPOSITIONAL_SPEC: &str =
    include_str!("../../../src/providers/realtime/preflight/compositional-route-spec.json");
const FRAME_LIMIT: usize = 32768;
const LOAD_TIMEOUT: Duration = Duration::from_secs(90);
const INFERENCE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub python_path: String,
    pub model_path: String,
    pub checkpoint: String,
    pub device: String,
    #[serde(default = "direct_strategy")]
    pub strategy: String,
}
fn direct_strategy() -> String {
    "direct".into()
}
impl Config {
    fn validate(&self) -> Result<()> {
        if !Path::new(&self.python_path).is_absolute() || !Path::new(&self.python_path).is_file() {
            return Err(Failure::RuntimeMissing);
        }
        if !Path::new(&self.model_path).is_absolute() || !Path::new(&self.model_path).is_dir() {
            return Err(Failure::ModelMissing);
        }
        if !["multilingual", "english", "typed-decisions"].contains(&self.checkpoint.as_str()) {
            return Err(Failure::InvalidInput);
        }
        if !["cpu", "cuda"].contains(&self.device.as_str()) {
            return Err(Failure::UnsupportedDevice);
        }
        if !["direct", "compositional"].contains(&self.strategy.as_str()) {
            return Err(Failure::InvalidInput);
        }
        Ok(())
    }
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: &'static str,
    pub reason: Option<Failure>,
    pub details: Option<Value>,
    pub active_requests: usize,
    pub queued_requests: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    id: u64,
    result: Option<Value>,
    failure: Option<Failure>,
}
fn read_frame(reader: &mut impl BufRead) -> Result<Reply> {
    let mut bytes = Zeroizing::new(Vec::new());
    // Read one byte at a time through BufReader: bounded even without a newline.
    loop {
        let buffer = reader.fill_buf().map_err(|_| Failure::WorkerExited)?;
        if buffer.is_empty() {
            return Err(Failure::WorkerExited);
        }
        let n = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(buffer.len());
        if bytes.len() + n > FRAME_LIMIT {
            return Err(Failure::InvalidResult);
        }
        let done = buffer[n - 1] == b'\n';
        bytes.extend_from_slice(&buffer[..n]);
        reader.consume(n);
        if done {
            break;
        }
    }
    let reply: Reply = serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidResult)?;
    if reply.result.is_some() == reply.failure.is_some() {
        return Err(Failure::InvalidResult);
    }
    Ok(reply)
}
struct Worker {
    child: Mutex<Child>,
    input: Arc<Mutex<ChildStdin>>,
    replies: Mutex<mpsc::Receiver<Result<Reply>>>,
}
impl Worker {
    fn spawn(config: &Config) -> Result<Self> {
        config.validate()?;
        let mut command = Command::new(&config.python_path);
        command
            .args(["-I", "-u", "-c", WORKER])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command.env(
            "COMPANION_ROUTING_PARENT_PID",
            std::process::id().to_string(),
        );
        for key in [
            "JEV_API_KEY",
            "TYPESAFE_API_KEY",
            "GEMINI_API_KEY",
            "OPENAI_API_KEY",
            "HF_TOKEN",
        ] {
            command.env_remove(key);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|_| Failure::RuntimeMissing)?;
        let input = child.stdin.take().ok_or(Failure::RuntimeMissing)?;
        let output = child.stdout.take().ok_or(Failure::RuntimeMissing)?;
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let reply = read_frame(&mut reader);
                let failed = reply.is_err();
                if sender.try_send(reply).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            child: Mutex::new(child),
            input: Arc::new(Mutex::new(input)),
            replies: Mutex::new(receiver),
        })
    }
    fn request(&self, id: u64, request: &Value, timeout: Duration) -> Result<Value> {
        let mut bytes =
            Zeroizing::new(serde_json::to_vec(request).map_err(|_| Failure::InvalidInput)?);
        if bytes.len() + 1 > FRAME_LIMIT {
            return Err(Failure::InvalidInput);
        }
        bytes.push(b'\n');
        // Include a blocked stdin write in the same deadline. One admitted
        // request means at most one writer, including during cancellation.
        let started = Instant::now();
        let input = self.input.clone();
        let (sent, written) = mpsc::sync_channel(1);
        let writer = std::thread::spawn(move || {
            let result = input
                .lock()
                .map_err(|_| Failure::WorkerExited)
                .and_then(|mut stream| stream.write_all(&bytes).map_err(|_| Failure::WorkerExited));
            let _ = sent.send(result);
        });
        let write_result = written.recv_timeout(timeout);
        if write_result.is_err() {
            self.kill();
        }
        let _ = writer.join();
        write_result.map_err(|_| Failure::Timeout)??;
        let reply = self
            .replies
            .lock()
            .map_err(|_| Failure::WorkerExited)?
            .recv_timeout(timeout.saturating_sub(started.elapsed()))
            .map_err(|e| match e {
                mpsc::RecvTimeoutError::Timeout => Failure::Timeout,
                _ => Failure::WorkerExited,
            })??;
        if reply.id != id {
            return Err(Failure::InvalidResult);
        }
        if let Some(failure) = reply.failure {
            return Err(failure);
        }
        reply.result.ok_or(Failure::InvalidResult)
    }
    fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.kill();
    }
}

struct State {
    epoch: u64,
    generation: u64,
    used: bool,
    active: bool,
    worker: Option<Arc<Worker>>,
    status: Status,
}
impl Default for State {
    fn default() -> Self {
        Self {
            epoch: 0,
            generation: 0,
            used: false,
            active: false,
            worker: None,
            status: Status {
                state: "Unavailable",
                reason: Some(Failure::ModelMissing),
                ..Default::default()
            },
        }
    }
}
#[derive(Default)]
pub struct Runtime {
    state: Mutex<State>,
}
impl Runtime {
    pub fn begin(&self) -> u64 {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.epoch = s.epoch.wrapping_add(1);
        s.used = false;
        s.epoch
    }
    pub fn cancel(&self, epoch: u64) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.epoch == epoch {
            s.epoch = s.epoch.wrapping_add(1);
            s.used = false;
        }
    }
    pub fn status(&self) -> Status {
        let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        Status {
            active_requests: usize::from(s.active),
            ..s.status.clone()
        }
    }
    pub fn unload(&self) {
        let worker = {
            let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            s.epoch = s.epoch.wrapping_add(1);
            s.generation = s.generation.wrapping_add(1);
            s.active = false;
            s.used = false;
            s.status = Status {
                state: "Unavailable",
                reason: Some(Failure::ModelMissing),
                ..Default::default()
            };
            s.worker.take()
        };
        if let Some(worker) = worker {
            worker.kill();
        }
    }
    pub fn start(&self, config: Config) -> Result<Status> {
        if let Err(error) = config.validate() {
            self.unload();
            self.state.lock().unwrap_or_else(|e| e.into_inner()).status = Status {
                state: "Failed",
                reason: Some(error),
                ..Default::default()
            };
            return Err(error);
        }
        // Explicit start/retry replaces the old runtime. Never called per turn.
        let (generation, old_worker) = {
            let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            s.epoch = s.epoch.wrapping_add(1);
            s.generation = s.generation.wrapping_add(1);
            s.active = false;
            s.used = false;
            s.status = Status {
                state: "Loading",
                ..Default::default()
            };
            (s.generation, s.worker.take())
        };
        if let Some(worker) = old_worker {
            worker.kill();
        }
        let result = (|| {
            let worker = Arc::new(Worker::spawn(&config)?);
            {
                let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
                if s.generation != generation {
                    return Err(Failure::Cancelled);
                }
                s.worker = Some(worker.clone());
            }
            let mut config = serde_json::to_value(config).map_err(|_| Failure::InvalidInput)?;
            config["lock"] = serde_json::from_str(MODEL_LOCK).map_err(|_| Failure::InvalidInput)?;
            config["spec"] = serde_json::from_str(SPEC).map_err(|_| Failure::InvalidInput)?;
            config["compositionalSpec"] =
                serde_json::from_str(COMPOSITIONAL_SPEC).map_err(|_| Failure::InvalidInput)?;
            worker.request(
                0,
                &json!({"id":0,"operation":"initialize","config":config}),
                LOAD_TIMEOUT,
            )
        })();
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.generation != generation {
            return Err(Failure::Cancelled);
        }
        match result {
            Ok(details) => {
                s.status = Status {
                    state: "Ready",
                    details: Some(details),
                    ..Default::default()
                };
                Ok(s.status.clone())
            }
            Err(error) => {
                s.status = Status {
                    state: "Failed",
                    reason: Some(error),
                    ..Default::default()
                };
                let worker = s.worker.take();
                drop(s);
                if let Some(worker) = worker {
                    worker.kill();
                }
                Err(error)
            }
        }
    }
    pub fn decide(&self, epoch: u64, input: Input, permitted: impl Fn() -> bool) -> Result<Value> {
        self.decide_with_timeout(epoch, input, permitted, INFERENCE_TIMEOUT)
    }
    fn decide_with_timeout(
        &self,
        epoch: u64,
        input: Input,
        permitted: impl Fn() -> bool,
        timeout: Duration,
    ) -> Result<Value> {
        input.validate()?;
        if !permitted() {
            return Err(Failure::Privacy);
        }
        let (worker, generation) = {
            let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if epoch != s.epoch {
                return Err(Failure::Cancelled);
            }
            if s.active || s.used {
                return Err(Failure::Busy);
            }
            if s.status.state != "Ready" {
                return Err(s.status.reason.unwrap_or(Failure::LoadFailed));
            }
            let worker = s.worker.clone().ok_or(Failure::WorkerExited)?;
            s.active = true;
            s.used = true;
            (worker, s.generation)
        };
        let started = Instant::now();
        let request = json!({"id":epoch,"operation":"decide","input":input});
        let result = if permitted() {
            worker.request(epoch, &request, timeout)
        } else {
            Err(Failure::Privacy)
        };
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.generation != generation {
            return Err(Failure::Cancelled);
        }
        s.active = false;
        // Technical corruption terminates this worker; cancelled decisions only
        // lose authority, preserving the resident model for the following turn.
        if let Err(
            error @ (Failure::Timeout
            | Failure::WorkerExited
            | Failure::InvalidResult
            | Failure::OutOfMemory
            | Failure::InferenceFailed),
        ) = result
        {
            s.status = Status {
                state: "Failed",
                reason: Some(error),
                ..Default::default()
            };
            s.worker.take();
            worker.kill();
        }
        if s.epoch != epoch {
            return Err(Failure::Cancelled);
        }
        if !permitted() {
            return Err(Failure::Privacy);
        }
        let mut value = result?;
        value["totalMs"] = json!(started.elapsed().as_secs_f64() * 1000.);
        if let Some(details) = value.get("status") {
            s.status.details = Some(details.clone());
        }
        Ok(value)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.unload();
    }
}

#[tauri::command]
pub fn laya_status(state: tauri::State<'_, crate::commands::AppState>) -> Status {
    state.3.status()
}
#[tauri::command]
pub fn laya_begin(state: tauri::State<'_, crate::commands::AppState>) -> u64 {
    state.3.begin()
}
#[tauri::command]
pub fn laya_cancel(state: tauri::State<'_, crate::commands::AppState>, epoch: u64) {
    state.3.cancel(epoch);
}
#[tauri::command]
pub async fn laya_start(
    state: tauri::State<'_, crate::commands::AppState>,
    config: Config,
) -> Result<Status> {
    let runtime = state.3.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.start(config))
        .await
        .map_err(|_| Failure::LoadFailed)?
}
#[tauri::command]
pub async fn laya_unload(state: tauri::State<'_, crate::commands::AppState>) -> Result<()> {
    let runtime = state.3.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || runtime.unload()).await;
    Ok(())
}
#[tauri::command]
pub async fn laya_decide(
    state: tauri::State<'_, crate::commands::AppState>,
    epoch: u64,
    input: Input,
) -> Result<Value> {
    let runtime = state.3.clone();
    let native = state.0.clone();
    let generation = native
        .lock()
        .map_err(|_| Failure::Privacy)?
        .visual_access_generation()
        .map_err(|_| Failure::Privacy)?;
    tauri::async_runtime::spawn_blocking(move || {
        runtime.decide(epoch, input, || {
            native
                .lock()
                .map(|s| s.visual_access_valid(generation))
                .unwrap_or(false)
        })
    })
    .await
    .map_err(|_| Failure::InferenceFailed)?
}
