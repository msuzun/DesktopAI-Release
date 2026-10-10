use super::{gpu::GpuAnalyzer, *};
use crate::temporal_memory::{SampleMetadata, TemporalMemory};
use crate::{
    perception::{PerceptionFrame, PerceptionOutput},
    platform::screen_capture::wgc::frame::GpuFrameHandle,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

// One in-flight GPU job plus the perception capacity-one input. This deliberately
// avoids pipelining an uncommitted baseline: failed readback cannot poison N+1.
const READBACK_RETRY: Duration = Duration::from_millis(2);
const READBACK_TIMEOUT: Duration = Duration::from_millis(500);
const MAX_CONSECUTIVE_FAILURES: u32 = 3;

// One diagnostic summary lets a 1Hz UI inspect a brief change. No frame, event
// history, or keyframe is retained; normal consumers still get only `latest`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSummary {
    pub source_frame_id: u64,
    pub analysis_sequence: u64,
    pub classification: Classification,
    pub bounds: Option<Bounds>,
    pub score: f64,
    pub area: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Statistics {
    pub last_change: Option<ChangeSummary>,
    pub state: &'static str,
    pub config: AnalysisConfig,
    pub analyzed_frames: u64,
    pub baseline_frames: u64,
    pub skipped_analysis_inputs: u64,
    pub duplicate_inputs: u64,
    pub analysis_failures: u64,
    pub baseline_resets: u64,
    pub resource_sets_created: u64,
    pub large_change_count: u64,
    pub medium_change_count: u64,
    pub small_change_count: u64,
    pub no_change_count: u64,
    pub readback_not_ready_count: u64,
    pub pending_readbacks: u32,
    pub compact_readback_bytes: u64,
    pub luma_readback_bytes: u64,
    pub luma_staging_bytes: usize,
    pub luma_scratch_bytes: usize,
    pub analysis_fps: f64,
    pub average_analysis_total_ms: f64,
    pub maximum_analysis_total_ms: f64,
    pub maximum_source_age_ms: f64,
    pub error: Option<AnalysisError>,
}
impl Default for Statistics {
    fn default() -> Self {
        Self {
            last_change: None,
            state: "Stopped",
            config: AnalysisConfig::default(),
            analyzed_frames: 0,
            baseline_frames: 0,
            skipped_analysis_inputs: 0,
            duplicate_inputs: 0,
            analysis_failures: 0,
            baseline_resets: 0,
            resource_sets_created: 0,
            large_change_count: 0,
            medium_change_count: 0,
            small_change_count: 0,
            no_change_count: 0,
            readback_not_ready_count: 0,
            pending_readbacks: 0,
            compact_readback_bytes: 0,
            luma_readback_bytes: 0,
            luma_staging_bytes: 0,
            luma_scratch_bytes: 0,
            analysis_fps: 0.,
            average_analysis_total_ms: 0.,
            maximum_analysis_total_ms: 0.,
            maximum_source_age_ms: 0.,
            error: None,
        }
    }
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub statistics: Statistics,
    pub latest: Option<VisualAnalysisResult>,
    pub temporal: crate::temporal_memory::Diagnostics,
    pub recent_gpu: crate::recent_gpu_cache::Diagnostics,
    pub events: crate::visual_events::Diagnostics,
}
struct Shared {
    last_published: Option<Instant>,
    statistics: Statistics,
    latest: Option<Arc<VisualAnalysisResult>>,
}
pub struct AnalysisEngine {
    events: crate::visual_events::EventEngine,
    recent_gpu: crate::recent_gpu_cache::RecentGpuFrameCache,
    history: TemporalMemory,
    shared: Arc<Mutex<Shared>>,
    input: PerceptionOutput<GpuFrameHandle>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl AnalysisEngine {
    pub fn start(input: PerceptionOutput<GpuFrameHandle>) -> Result<Self> {
        let shared = Arc::new(Mutex::new(Shared {
            last_published: None,
            statistics: Statistics {
                state: "WaitingForFrame",
                ..Statistics::default()
            },
            latest: None,
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let history = TemporalMemory::new(Default::default());
        let recent_gpu = crate::recent_gpu_cache::RecentGpuFrameCache::new(Default::default());
        let events = crate::visual_events::EventEngine::start(history.clone(), recent_gpu.clone());
        let worker_events = events.sink();
        let worker_recent = recent_gpu.clone();
        let worker_history = history.clone();
        let (state, cancelled, frames) = (shared.clone(), stop.clone(), input.clone());
        let worker = std::thread::Builder::new()
            .name("gpu-visual-analysis".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run(
                        &frames,
                        &cancelled,
                        &state,
                        &worker_history,
                        &worker_recent,
                        &worker_events,
                    )
                }))
                .unwrap_or_else(|_| {
                    Err(AnalysisError::new(
                        "analysis_worker",
                        "GPU analysis worker failed.",
                        false,
                    ))
                });
                worker_events.stop();
                worker_recent.stop();
                worker_history.stop();
                let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                s.latest = None;
                s.statistics.last_change = None;
                s.statistics.pending_readbacks = 0;
                s.statistics.analysis_fps = 0.;
                s.statistics.luma_staging_bytes = 0;
                s.statistics.luma_scratch_bytes = 0;
                s.statistics.state = if result.is_err() { "Failed" } else { "Stopped" };
                if let Err(error) = result {
                    s.statistics.analysis_failures += 1;
                    s.statistics.error = Some(error);
                }
            })
            .map_err(|_| {
                AnalysisError::new(
                    "analysis_worker_start",
                    "Could not start GPU analysis worker.",
                    false,
                )
            })?;
        Ok(Self {
            events,
            recent_gpu,
            history,
            shared,
            input,
            stop,
            worker: Some(worker),
        })
    }
    pub fn snapshot(&self) -> Snapshot {
        let state = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        let mut statistics = state.statistics.clone();
        if state
            .last_published
            .is_none_or(|t| t.elapsed() >= Duration::from_secs(2))
        {
            statistics.analysis_fps = 0.;
        }
        Snapshot {
            statistics,
            latest: state.latest.as_deref().cloned(),
            temporal: self.history.diagnostics(Instant::now()),
            recent_gpu: self.recent_gpu.diagnostics(Instant::now()),
            events: self.events.memory().diagnostics(Instant::now()),
        }
    }
    pub fn temporal_memory(&self) -> TemporalMemory {
        self.history.clone()
    }
    pub fn recent_gpu_cache(&self) -> crate::recent_gpu_cache::RecentGpuFrameCache {
        self.recent_gpu.clone()
    }
    pub fn event_memory(&self) -> crate::visual_events::EventMemory {
        self.events.memory()
    }
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.events.request_stop();
        self.recent_gpu.stop();
        self.history.stop();
        self.input.wake();
    }
    pub fn stop(&mut self) {
        self.request_stop();
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
        self.events.stop();
    }
}
impl Drop for AnalysisEngine {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(
    input: &PerceptionOutput<GpuFrameHandle>,
    stop: &AtomicBool,
    shared: &Mutex<Shared>,
    history: &TemporalMemory,
    recent_gpu: &crate::recent_gpu_cache::RecentGpuFrameCache,
    events: &crate::visual_events::EventSink,
) -> Result<()> {
    let config = AnalysisConfig::default();
    let mut temporal = TemporalState::default();
    let mut gpu: Option<GpuAnalyzer> = None;
    let mut consecutive_failures = 0;
    let mut rate_started = Instant::now();
    let mut rate_frames = 0;
    while let Some(frame) = input.wait_next(stop) {
        // This Arc owns both the PerceptionFrame and its COM texture through GPU
        // completion. Stop drops it only as the worker exits; D3D11 also defers
        // resource destruction for submitted commands. No source history remains.
        let accepted_at = Instant::now();
        let result = analyze(
            &frame,
            &mut gpu,
            &mut temporal,
            accepted_at,
            AnalysisContext {
                config,
                input,
                stop,
                shared,
                history,
                recent_gpu,
                events,
            },
        );
        if stop.load(Ordering::Acquire) || !input.running() {
            return Ok(());
        }
        match result {
            Ok(Some(mut result)) => {
                consecutive_failures = 0;
                let published_at = Instant::now();
                let metadata = SampleMetadata::from_analysis(
                    &result,
                    frame.source.source_timestamp,
                    frame.perceived_at,
                    published_at,
                );
                result.analysis_total_ms =
                    published_at.duration_since(accepted_at).as_secs_f64() * 1000.;
                result.source_age_at_publication_ms = published_at
                    .saturating_duration_since(frame.source.source_timestamp)
                    .as_secs_f64()
                    * 1000.;
                result.perception_to_publication_ms = published_at
                    .saturating_duration_since(frame.perceived_at)
                    .as_secs_f64()
                    * 1000.;
                let mut s = shared.lock().unwrap_or_else(|e| e.into_inner());
                let stats = &mut s.statistics;
                stats.state = if result.kind == ResultKind::BaselineEstablished {
                    "BaselineEstablished"
                } else {
                    "TemporalAnalysisActive"
                };
                stats.analyzed_frames += 1;
                stats.baseline_frames += u64::from(result.kind == ResultKind::BaselineEstablished);
                stats.pending_readbacks = 0;
                stats.compact_readback_bytes +=
                    (result.geometry.tile_count() * std::mem::size_of::<GpuTile>()) as u64;
                if let Some(gpu) = &gpu {
                    stats.luma_readback_bytes += gpu.luma().len() as u64 * 2;
                    stats.luma_staging_bytes = gpu.luma_staging_bytes();
                    stats.luma_scratch_bytes = gpu.luma_scratch_bytes();
                }
                stats.skipped_analysis_inputs = temporal.skipped;
                stats.baseline_resets = temporal.resets;
                stats.average_analysis_total_ms += (result.analysis_total_ms
                    - stats.average_analysis_total_ms)
                    / stats.analyzed_frames as f64;
                stats.maximum_analysis_total_ms = stats
                    .maximum_analysis_total_ms
                    .max(result.analysis_total_ms);
                stats.maximum_source_age_ms = stats
                    .maximum_source_age_ms
                    .max(result.source_age_at_publication_ms);
                if let Some(metrics) = &result.metrics {
                    if metrics.classification != Classification::None {
                        stats.last_change = Some(ChangeSummary {
                            source_frame_id: result.source_frame_id,
                            analysis_sequence: result.analysis_sequence,
                            classification: metrics.classification,
                            bounds: metrics.change_bounds,
                            score: metrics.global_change_score,
                            area: metrics.changed_area_ratio,
                        });
                    }
                    match metrics.classification {
                        Classification::None => stats.no_change_count += 1,
                        Classification::Small => stats.small_change_count += 1,
                        Classification::Medium => stats.medium_change_count += 1,
                        Classification::Large => stats.large_change_count += 1,
                    }
                }
                let elapsed = rate_started.elapsed().as_secs_f64();
                if elapsed >= 1. {
                    stats.analysis_fps = (stats.analyzed_frames - rate_frames) as f64 / elapsed;
                    rate_frames = stats.analyzed_frames;
                    rate_started = Instant::now();
                }
                s.latest = Some(Arc::new(result));
                s.last_published = Some(published_at);
                drop(s);
                // Realtime publication stays independent of history. Only a packed
                // low-resolution copy and compact metadata enter the ring. The
                // frame Arc is dropped normally at this iteration's end.
                let temporal_id = gpu
                    .as_ref()
                    .and_then(|gpu| history.push(metadata, gpu.luma(), Instant::now()).ok());
                recent_gpu.insert(&frame, metadata.analysis_sequence);
                if let Some(id) = temporal_id {
                    let mut sample = metadata;
                    sample.id = id;
                    events.submit(sample);
                }
            }
            Ok(None) => {
                shared
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .statistics
                    .duplicate_inputs += 1;
            }
            Err(error) if error.recoverable => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    return Err(AnalysisError {
                        recoverable: false,
                        ..error
                    });
                }
                let mut s = shared.lock().unwrap_or_else(|e| e.into_inner());
                s.statistics.analysis_failures += 1;
                s.statistics.pending_readbacks = 0;
                s.statistics.error = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

struct AnalysisContext<'a> {
    config: AnalysisConfig,
    input: &'a PerceptionOutput<GpuFrameHandle>,
    stop: &'a AtomicBool,
    shared: &'a Mutex<Shared>,
    history: &'a TemporalMemory,
    recent_gpu: &'a crate::recent_gpu_cache::RecentGpuFrameCache,
    events: &'a crate::visual_events::EventSink,
}

fn analyze(
    frame: &PerceptionFrame<GpuFrameHandle>,
    gpu: &mut Option<GpuAnalyzer>,
    temporal: &mut TemporalState,
    accepted_at: Instant,
    context: AnalysisContext<'_>,
) -> Result<Option<VisualAnalysisResult>> {
    let AnalysisContext {
        config,
        input,
        stop,
        shared,
        history,
        recent_gpu,
        events,
    } = context;
    let new_device = match gpu {
        Some(gpu) => !gpu.same_device(&frame.gpu_frame_handle)?,
        None => true,
    };
    if new_device {
        *gpu = Some(GpuAnalyzer::new(&frame.gpu_frame_handle, config)?);
    }
    let gpu = gpu.as_mut().ok_or_else(|| {
        AnalysisError::new(
            "analysis_initialize",
            "Analysis resources were not initialized.",
            false,
        )
    })?;
    let before = gpu.resource_sets;
    let rebuilt = gpu.prepare(&frame.gpu_frame_handle, config)? || new_device;
    let Some(ticket) = temporal.accept(frame.source, frame.perception_sequence, rebuilt) else {
        return Ok(None);
    };
    // Baseline/reset boundaries invalidate history even if this dispatch fails.
    if ticket.previous.is_none() {
        events.invalidate();
        recent_gpu.clear();
    }
    // A ring configuration/allocation error disables history, not perception.
    let _ = history.prepare(
        frame.source.capture_generation,
        gpu.geometry(),
        ticket.previous.is_none(),
    );
    {
        let mut s = shared.lock().unwrap_or_else(|e| e.into_inner());
        s.statistics.state = "ResourcesReady";
        s.statistics.resource_sets_created += gpu.resource_sets - before + u64::from(new_device);
        s.statistics.pending_readbacks = 1;
    }
    let dispatch_at = Instant::now();
    gpu.submit(&frame.gpu_frame_handle, config, ticket.previous.is_none())?;
    let dispatch_cpu_ms = dispatch_at.elapsed().as_secs_f64() * 1000.;
    let tiles = loop {
        if stop.load(Ordering::Acquire) || !input.running() {
            return Ok(None);
        }
        if let Some(tiles) = gpu.poll()? {
            break tiles;
        }
        shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .statistics
            .readback_not_ready_count += 1;
        if dispatch_at.elapsed() >= READBACK_TIMEOUT {
            return Err(AnalysisError::new(
                "readback_timeout",
                "GPU analysis completion exceeded the bounded wait. Restart Screen Awareness.",
                false,
            ));
        }
        // No busy spin. Capture/perception keep publishing while this one job is
        // in flight. New pending input replaces older input in the perception slot.
        // Rust's Windows sleep uses a high-resolution waitable timer where
        // supported; park_timeout rounds to ~15.6ms on the validated machine.
        // Stop checks run on either side of this bounded 2ms wait, never a spin.
        std::thread::sleep(READBACK_RETRY);
    };
    let completion_readback_latency_ms = dispatch_at.elapsed().as_secs_f64() * 1000.;
    let cpu_at = Instant::now();
    let geometry = gpu.geometry();
    let metrics = match reduce_tiles(geometry, &tiles[..geometry.tile_count()], config) {
        Ok(metrics) => metrics,
        Err(error) => {
            gpu.finish(false);
            return Err(error);
        }
    };
    gpu.finish(true);
    temporal.commit(&ticket);
    let baseline = ticket.previous.is_none();
    Ok(Some(VisualAnalysisResult {
        kind: if baseline {
            ResultKind::BaselineEstablished
        } else {
            ResultKind::Analyzed
        },
        capture_generation: frame.source.capture_generation,
        source_frame_id: frame.source.frame_id,
        previous_source_frame_id: ticket.previous,
        perception_sequence: frame.perception_sequence,
        analysis_sequence: ticket.sequence,
        geometry,
        metrics: if baseline { None } else { Some(metrics) },
        analysis_total_ms: accepted_at.elapsed().as_secs_f64() * 1000.,
        dispatch_cpu_ms,
        completion_readback_latency_ms,
        cpu_result_processing_ms: cpu_at.elapsed().as_secs_f64() * 1000.,
        source_age_at_publication_ms: 0.,
        perception_to_publication_ms: 0.,
    }))
}
