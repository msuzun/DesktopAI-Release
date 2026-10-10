//! Local GPU-handle selection only. Capture, perception and AI submission have independent clocks.
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug)]
pub struct PerceptionConfig {
    target_fps: u32,
}
impl Default for PerceptionConfig {
    fn default() -> Self {
        Self { target_fps: 30 }
    }
}
impl PerceptionConfig {
    pub fn new(target_fps: u32) -> Result<Self, PerceptionError> {
        match target_fps {
            10 | 30 | 60 => Ok(Self { target_fps }),
            _ => Err(PerceptionError::InvalidRate),
        }
    }
    pub fn target_fps(self) -> u32 {
        self.target_fps
    }
    fn interval(self) -> Duration {
        Duration::from_secs_f64(1. / self.target_fps as f64)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub enum PerceptionError {
    InvalidRate,
    CaptureNotRunning,
    CaptureFailed,
    GenerationChanged,
    WorkerStart,
    WorkerFailed,
}

#[derive(Clone, Copy)]
pub struct FrameMetadata {
    pub capture_generation: u64,
    pub frame_id: u64,
    pub source_timestamp: Instant,
    pub width: u32,
    pub height: u32,
    pub pixel_format: &'static str,
}
pub trait SourceFrame: Send + Sync + 'static {
    fn metadata(&self) -> FrameMetadata;
}
pub struct SourceSnapshot<F> {
    pub generation: u64,
    pub latest: Option<Arc<F>>,
}
pub trait FrameSource: Send + 'static {
    type Frame: SourceFrame;
    // Must only clone the latest handle under a short lock; no device work or readback.
    fn sample(&self) -> Result<SourceSnapshot<Self::Frame>, PerceptionError>;
}

// Not serializable: this is the native M7.3 boundary, never an IPC/image stream.
// Cloning the Arc clones ownership, never GPU texture contents. A consumer must
// release its in-flight frame on stop and must not build its own unbounded queue.
pub struct PerceptionFrame<F> {
    pub perception_sequence: u64,
    pub source: FrameMetadata,
    pub perceived_at: Instant,
    pub gpu_frame_handle: Arc<F>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Statistics {
    pub state: &'static str,
    pub target_fps: u32,
    pub capture_generation: Option<u64>,
    pub ticks: u64,
    pub frames_consumed: u64,
    pub ticks_without_new_frame: u64,
    pub source_frames_skipped: u64,
    pub perception_frames_replaced: u64,
    pub missed_deadlines: u64,
    pub overrun_count: u64,
    pub actual_fps: f64,
    pub tick_fps: f64,
    pub average_tick_interval_ms: f64,
    pub average_scheduler_jitter_ms: f64,
    pub maximum_scheduler_jitter_ms: f64,
    pub average_tick_processing_ms: f64,
    pub maximum_tick_processing_ms: f64,
    pub last_consumed_source_frame_id: Option<u64>,
    pub last_perception_sequence: Option<u64>,
    pub last_perception_age_ms: Option<f64>,
    pub maximum_perception_age_ms: f64,
    pub latest_frame_age_ms: Option<f64>,
    pub error: Option<PerceptionError>,
}
impl Statistics {
    pub fn stopped(config: PerceptionConfig) -> Self {
        Self {
            state: "Stopped",
            target_fps: config.target_fps(),
            capture_generation: None,
            ticks: 0,
            frames_consumed: 0,
            ticks_without_new_frame: 0,
            source_frames_skipped: 0,
            perception_frames_replaced: 0,
            missed_deadlines: 0,
            overrun_count: 0,
            actual_fps: 0.,
            tick_fps: 0.,
            average_tick_interval_ms: 0.,
            average_scheduler_jitter_ms: 0.,
            maximum_scheduler_jitter_ms: 0.,
            average_tick_processing_ms: 0.,
            maximum_tick_processing_ms: 0.,
            last_consumed_source_frame_id: None,
            last_perception_sequence: None,
            last_perception_age_ms: None,
            maximum_perception_age_ms: 0.,
            latest_frame_age_ms: None,
            error: None,
        }
    }
}

struct State<F> {
    stats: Statistics,
    latest: Option<Arc<PerceptionFrame<F>>>,
    last_tick: Option<Instant>,
    last_source_timestamp: Option<Instant>,
    rate_started: Instant,
    rate_ticks: u64,
    rate_frames: u64,
}
impl<F: SourceFrame> State<F> {
    fn new(config: PerceptionConfig, generation: u64) -> Self {
        let mut stats = Statistics::stopped(config);
        stats.state = "Running";
        stats.capture_generation = Some(generation);
        Self {
            stats,
            latest: None,
            last_tick: None,
            last_source_timestamp: None,
            rate_started: Instant::now(),
            rate_ticks: 0,
            rate_frames: 0,
        }
    }
    fn select(
        &mut self,
        sample: SourceSnapshot<F>,
        now: Instant,
        deadline: Instant,
    ) -> Result<(), PerceptionError> {
        if Some(sample.generation) != self.stats.capture_generation {
            return Err(PerceptionError::GenerationChanged);
        }
        let s = &mut self.stats;
        s.ticks += 1;
        if let Some(last) = self.last_tick.replace(now) {
            let interval = now.duration_since(last).as_secs_f64() * 1000.;
            s.average_tick_interval_ms +=
                (interval - s.average_tick_interval_ms) / (s.ticks - 1) as f64;
        }
        let jitter = now.saturating_duration_since(deadline).as_secs_f64() * 1000.;
        s.average_scheduler_jitter_ms += (jitter - s.average_scheduler_jitter_ms) / s.ticks as f64;
        s.maximum_scheduler_jitter_ms = s.maximum_scheduler_jitter_ms.max(jitter);
        if let Some(frame) = sample.latest {
            let metadata = frame.metadata();
            if metadata.capture_generation != sample.generation {
                return Err(PerceptionError::GenerationChanged);
            }
            if s.last_consumed_source_frame_id
                .is_none_or(|id| metadata.frame_id > id)
            {
                if let Some(id) = s.last_consumed_source_frame_id {
                    s.source_frames_skipped += metadata.frame_id - id - 1;
                }
                s.frames_consumed += 1;
                s.last_consumed_source_frame_id = Some(metadata.frame_id);
                s.last_perception_sequence = Some(s.frames_consumed);
                let age = now
                    .saturating_duration_since(metadata.source_timestamp)
                    .as_secs_f64()
                    * 1000.;
                s.last_perception_age_ms = Some(age);
                s.maximum_perception_age_ms = s.maximum_perception_age_ms.max(age);
                self.last_source_timestamp = Some(metadata.source_timestamp);
                // Capacity one, unread output replaced immediately. No downstream work under this lock.
                s.perception_frames_replaced += u64::from(
                    self.latest
                        .replace(Arc::new(PerceptionFrame {
                            perception_sequence: s.frames_consumed,
                            source: metadata,
                            perceived_at: now,
                            gpu_frame_handle: frame,
                        }))
                        .is_some(),
                );
            } else {
                s.ticks_without_new_frame += 1;
            }
        } else {
            s.ticks_without_new_frame += 1;
        }
        let elapsed = now.duration_since(self.rate_started).as_secs_f64();
        if elapsed >= 1. {
            s.actual_fps = (s.frames_consumed - self.rate_frames) as f64 / elapsed;
            s.tick_fps = (s.ticks - self.rate_ticks) as f64 / elapsed;
            self.rate_started = now;
            self.rate_frames = s.frames_consumed;
            self.rate_ticks = s.ticks;
        }
        Ok(())
    }
    fn finish(&mut self, error: Option<PerceptionError>) {
        self.latest = None;
        self.last_tick = None;
        self.last_source_timestamp = None;
        self.stats.state = if error.is_some() { "Failed" } else { "Stopped" };
        self.stats.error = error;
        self.stats.capture_generation = None;
        self.stats.last_consumed_source_frame_id = None;
        self.stats.last_perception_sequence = None;
        self.stats.last_perception_age_ms = None;
        self.stats.latest_frame_age_ms = None;
        self.stats.actual_fps = 0.;
        self.stats.tick_fps = 0.;
    }
}

// Preserve the original deadline grid. Skip elapsed slots arithmetically (O(1)),
// including a deadline exactly at completion: never replay missed ticks.
fn advance_deadline(deadline: Instant, finished: Instant, interval: Duration) -> (Instant, u64) {
    let candidate = deadline + interval;
    if candidate > finished {
        return (candidate, 0);
    }
    let late = finished.duration_since(candidate).as_nanos();
    let missed = late / interval.as_nanos() + 1;
    let remainder = (late % interval.as_nanos()) as u64;
    (
        finished + interval - Duration::from_nanos(remainder),
        missed as u64,
    )
}

pub struct PerceptionEngine<F: SourceFrame> {
    shared: Arc<Mutex<State<F>>>,
    wake: Arc<Condvar>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
// One native consumer takes from the same capacity-one slot. It can wait without
// holding the lifecycle manager or causing the perception scheduler to wait.
pub struct PerceptionOutput<F: SourceFrame> {
    shared: Arc<Mutex<State<F>>>,
    wake: Arc<Condvar>,
}
impl<F: SourceFrame> Clone for PerceptionOutput<F> {
    fn clone(&self) -> Self {
        Self {
            shared: self.shared.clone(),
            wake: self.wake.clone(),
        }
    }
}
impl<F: SourceFrame> PerceptionOutput<F> {
    pub fn wait_next(&self, stop: &AtomicBool) -> Option<Arc<PerceptionFrame<F>>> {
        let s = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        let mut s = self
            .wake
            .wait_while(s, |s| {
                s.latest.is_none() && s.stats.state == "Running" && !stop.load(Ordering::Acquire)
            })
            .unwrap_or_else(|e| e.into_inner());
        if stop.load(Ordering::Acquire) || s.stats.state != "Running" {
            return None;
        }
        s.latest.take()
    }
    pub fn running(&self) -> bool {
        self.shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .stats
            .state
            == "Running"
    }
    pub fn wake(&self) {
        // Take the predicate lock so a stop notification cannot be lost between
        // wait_while's predicate check and its atomic unlock/wait operation.
        let _guard = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        self.wake.notify_all();
    }
}
impl<F: SourceFrame> PerceptionEngine<F> {
    pub fn start(
        source: impl FrameSource<Frame = F>,
        config: PerceptionConfig,
    ) -> Result<Self, PerceptionError> {
        let generation = source.sample()?.generation;
        let shared = Arc::new(Mutex::new(State::new(config, generation)));
        let wake = Arc::new(Condvar::new());
        let published = wake.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let (state, cancelled) = (shared.clone(), stop.clone());
        let worker = std::thread::Builder::new()
            .name("visual-perception".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let interval = config.interval();
                    let mut deadline = Instant::now();
                    while !cancelled.load(Ordering::Acquire) {
                        let now = Instant::now();
                        if now < deadline {
                            std::thread::park_timeout(deadline - now);
                            continue; // Handles spurious wakes and cancellation without spinning.
                        }
                        let sample = source.sample()?;
                        let selected_at = Instant::now();
                        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                        if cancelled.load(Ordering::Acquire) {
                            break;
                        }
                        s.select(sample, selected_at, deadline)?;
                        let finished = Instant::now();
                        let processing = finished.duration_since(now);
                        let ms = processing.as_secs_f64() * 1000.;
                        s.stats.average_tick_processing_ms +=
                            (ms - s.stats.average_tick_processing_ms) / s.stats.ticks as f64;
                        s.stats.maximum_tick_processing_ms =
                            s.stats.maximum_tick_processing_ms.max(ms);
                        s.stats.overrun_count += u64::from(processing > interval);
                        let (next, missed) = advance_deadline(deadline, finished, interval);
                        s.stats.missed_deadlines += missed;
                        deadline = next;
                        drop(s);
                        published.notify_one();
                    }
                    Ok::<(), PerceptionError>(())
                }))
                .unwrap_or(Err(PerceptionError::WorkerFailed));
                state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .finish(result.err());
                published.notify_all();
            })
            .map_err(|_| PerceptionError::WorkerStart)?;
        Ok(Self {
            shared,
            wake,
            stop,
            worker: Some(worker),
        })
    }
    pub fn snapshot(&self) -> Statistics {
        let s = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        let mut stats = s.stats.clone();
        stats.latest_frame_age_ms = s
            .last_source_timestamp
            .map(|t| t.elapsed().as_secs_f64() * 1000.);
        stats
    }
    pub fn output(&self) -> PerceptionOutput<F> {
        PerceptionOutput {
            shared: self.shared.clone(),
            wake: self.wake.clone(),
        }
    }
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
        let mut state = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        let error = state.stats.error;
        state.finish(error);
    }
}
impl<F: SourceFrame> Drop for PerceptionEngine<F> {
    fn drop(&mut self) {
        self.stop();
    }
}
