mod device;
pub mod error;
pub mod frame;
mod producer;
pub(crate) mod readback;
use error::{CaptureError, Result};
use frame::{GpuFrameHandle, PIXEL_FORMAT, POOL_BUFFERS};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex, MutexGuard,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Statistics {
    pub capture_generation: u64,
    pub state: &'static str,
    pub frames_received: u64,
    pub frames_replaced: u64,
    pub frames_skipped: u64,
    pub last_frame_id: u64,
    pub width: u32,
    pub height: u32,
    pub pixel_format: &'static str,
    pub pool_buffers: i32,
    pub pool_recreations: u64,
    pub capture_errors: u64,
    pub readbacks: u64,
    pub observed_fps: f64,
    pub last_frame_age_ms: Option<f64>,
    pub system_relative_100ns: Option<i64>,
    pub last_interval_ms: Option<f64>,
    pub startup_ms: f64,
    pub acquisition_ms: f64,
    pub copy_submit_ms: f64,
    pub error: Option<CaptureError>,
}
impl Default for Statistics {
    fn default() -> Self {
        Self {
            capture_generation: 0,
            state: "Stopped",
            frames_received: 0,
            frames_replaced: 0,
            frames_skipped: 0,
            last_frame_id: 0,
            width: 0,
            height: 0,
            pixel_format: PIXEL_FORMAT,
            pool_buffers: POOL_BUFFERS,
            pool_recreations: 0,
            capture_errors: 0,
            readbacks: 0,
            observed_fps: 0.,
            last_frame_age_ms: None,
            system_relative_100ns: None,
            last_interval_ms: None,
            startup_ms: 0.,
            acquisition_ms: 0.,
            copy_submit_ms: 0.,
            error: None,
        }
    }
}
struct Data {
    latest: Option<Arc<GpuFrameHandle>>,
    stats: Statistics,
    sample: Instant,
    sample_frames: u64,
}
struct Shared(Mutex<Data>);
impl Shared {
    fn lock(&self) -> MutexGuard<'_, Data> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}
// A read-only view of one capture generation, not ownership of the producer worker.
// Its lock covers only status inspection and an Arc clone, never D3D work.
pub struct WgcFrameSource(Arc<Shared>);
impl crate::perception::FrameSource for WgcFrameSource {
    type Frame = GpuFrameHandle;
    fn sample(
        &self,
    ) -> std::result::Result<
        crate::perception::SourceSnapshot<GpuFrameHandle>,
        crate::perception::PerceptionError,
    > {
        use crate::perception::{PerceptionError, SourceSnapshot};
        let data = self.0.lock();
        match data.stats.state {
            "Running" => Ok(SourceSnapshot {
                generation: data.stats.capture_generation,
                latest: data.latest.clone(),
            }),
            "Error" => Err(PerceptionError::CaptureFailed),
            _ => Err(PerceptionError::CaptureNotRunning),
        }
    }
}
pub struct WgcCapture {
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    commands: SyncSender<producer::Command>,
}
impl WgcCapture {
    pub fn start() -> Result<Self> {
        // WinRT activation factories are process-cached by windows-rs. Keep the MTA
        // runtime resident too: tearing down the last apartment between sessions
        // unloaded GraphicsCapture.dll while Windows still had teardown callbacks.
        // One process-lifetime COM cookie, not a device/session/frame reference.
        static MTA: std::sync::OnceLock<Result<()>> = std::sync::OnceLock::new();
        MTA.get_or_init(|| unsafe {
            windows::Win32::System::Com::CoIncrementMTAUsage()
                .map(|_| ())
                .map_err(|e| CaptureError::windows("winrt_init", e))
        })
        .clone()?;
        static GENERATION: AtomicU64 = AtomicU64::new(0);
        let shared = Arc::new(Shared(Mutex::new(Data {
            latest: None,
            stats: Statistics {
                capture_generation: GENERATION.fetch_add(1, Ordering::Relaxed) + 1,
                ..Statistics::default()
            },
            sample: Instant::now(),
            sample_frames: 0,
        })));
        let stop = Arc::new(AtomicBool::new(false));
        let (wake_tx, wake_rx) = mpsc::sync_channel(1);
        let (commands, requests) = mpsc::sync_channel(1);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (s, c) = (shared.clone(), stop.clone());
        let worker = std::thread::Builder::new()
            .name("wgc-capture".into())
            .spawn(move || producer::run(s, c, wake_tx, wake_rx, requests, ready_tx))
            .map_err(|_| CaptureError::new("worker_start"))?;
        let mut capture = Self {
            shared,
            stop,
            worker: Some(worker),
            commands,
        };
        if let Err(error) = ready_rx
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| CaptureError::new("startup_timeout"))
            .and_then(|r| r)
        {
            capture.stop();
            return Err(error);
        }
        Ok(capture)
    }
    pub fn snapshot(&self) -> Statistics {
        let mut s = self.shared.lock();
        let elapsed = s.sample.elapsed().as_secs_f64();
        if elapsed >= 1. {
            s.stats.observed_fps = (s.stats.frames_received - s.sample_frames) as f64 / elapsed;
            s.sample_frames = s.stats.frames_received;
            s.sample = Instant::now();
        }
        s.stats.last_frame_age_ms = s
            .latest
            .as_ref()
            .map(|f| f.received.elapsed().as_secs_f64() * 1000.);
        s.stats.system_relative_100ns = s.latest.as_ref().map(|f| f.system_relative_100ns);
        if let Some(frame) = s.latest.as_ref() {
            s.stats.last_frame_id = frame.frame_id;
        }
        s.stats.clone()
    }
    pub fn frame_source(&self) -> WgcFrameSource {
        WgcFrameSource(self.shared.clone())
    }
    pub fn readback_for_developer_preview(&self) -> Result<image::RgbaImage> {
        if self.stop.load(Ordering::Acquire) {
            return Err(CaptureError::new("stopped"));
        }
        let (tx, rx) = mpsc::sync_channel(1);
        self.commands
            .try_send(producer::Command::Preview(tx))
            .map_err(|_| CaptureError::new("busy"))?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| CaptureError::new("readback_timeout"))?
    }
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        {
            let mut s = self.shared.lock();
            s.latest = None;
            if s.stats.state == "Running" {
                s.stats.state = "Stopping";
            }
        }
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                let mut s = self.shared.lock();
                s.stats.state = "Error";
                s.stats.error = Some(CaptureError::new("worker_failed"));
            }
        }
    }
}
impl Drop for WgcCapture {
    fn drop(&mut self) {
        self.stop();
    }
}
