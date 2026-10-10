use crate::error::AppError;
use crate::perception::{PerceptionConfig, Statistics as PerceptionStatistics};
#[cfg(windows)]
use crate::platform::screen_capture::wgc::{Statistics, WgcCapture};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
pub enum BackendKind {
    Legacy,
    WindowsGraphicsCapture,
}
impl Default for BackendKind {
    fn default() -> Self {
        if cfg!(windows) {
            Self::WindowsGraphicsCapture
        } else {
            Self::Legacy
        }
    }
}
impl BackendKind {
    pub fn supports_continuous_gpu_frames(self) -> bool {
        cfg!(windows) && self == Self::WindowsGraphicsCapture
    }
}
#[derive(Default)]
pub struct CaptureManager {
    pub selected: BackendKind,
    active: bool,
    perception_config: PerceptionConfig,
    last_perception: Option<PerceptionStatistics>,
    #[cfg(windows)]
    perception: Option<
        crate::perception::PerceptionEngine<
            crate::platform::screen_capture::wgc::frame::GpuFrameHandle,
        >,
    >,
    #[cfg(windows)]
    capture: Option<WgcCapture>,
    #[cfg(windows)]
    analysis: Option<crate::visual_analysis::AnalysisEngine>,
    #[cfg(windows)]
    last_analysis: crate::visual_analysis::Snapshot,
    #[cfg(windows)]
    last: Statistics,
}
impl CaptureManager {
    pub fn select(&mut self, backend: BackendKind) -> Result<(), AppError> {
        if self.active {
            return Err(AppError::new(
                "capture_busy",
                "Stop the companion before changing capture backend.",
            ));
        }
        self.selected = backend;
        self.last_perception = None;
        #[cfg(windows)]
        {
            self.last_analysis = Default::default();
        }
        Ok(())
    }
    pub fn configure_perception(&mut self, target_fps: u32) -> Result<(), AppError> {
        let config = PerceptionConfig::new(target_fps).map_err(|_| {
            AppError::new(
                "invalid_perception_rate",
                "Perception rate must be 10, 30 or 60 FPS.",
            )
        })?;
        if self.active {
            return Err(AppError::new(
                "capture_busy",
                "Stop the companion before changing perception rate.",
            ));
        }
        self.perception_config = config;
        self.last_perception = None;
        Ok(())
    }
    pub fn start(&mut self) -> Result<(), AppError> {
        if self.active {
            return Ok(());
        }
        self.last_perception = None;
        if self.selected == BackendKind::WindowsGraphicsCapture {
            #[cfg(windows)]
            {
                match WgcCapture::start() {
                    Ok(mut capture) => {
                        match crate::perception::PerceptionEngine::start(
                            capture.frame_source(),
                            self.perception_config,
                        ) {
                            Ok(engine) => {
                                self.last_analysis = Default::default();
                                match crate::visual_analysis::AnalysisEngine::start(engine.output())
                                {
                                    Ok(analyzer) => self.analysis = Some(analyzer),
                                    Err(error) => {
                                        self.last_analysis.statistics.state = "Failed";
                                        self.last_analysis.statistics.analysis_failures = 1;
                                        self.last_analysis.statistics.error = Some(error);
                                    }
                                }
                                self.perception = Some(engine);
                            }
                            Err(error) => {
                                let mut stats =
                                    PerceptionStatistics::stopped(self.perception_config);
                                stats.state = "Failed";
                                stats.error = Some(error);
                                self.last_perception = Some(stats);
                                capture.stop();
                                self.last = capture.snapshot();
                                return Err(AppError::new(
                                    "perception_start_failed",
                                    "Local perception could not start. Check Developer diagnostics and restart.",
                                ));
                            }
                        }
                        self.capture = Some(capture);
                    }
                    Err(error) => {
                        self.last = Statistics::default();
                        self.last.state = "Error";
                        self.last.capture_errors = 1;
                        self.last.error = Some(error.clone());
                        return Err(AppError::new(error.code, error.message));
                    }
                }
            }
            #[cfg(not(windows))]
            {
                return Err(AppError::new(
                    "unsupported",
                    "Windows Graphics Capture is only available on Windows.",
                ));
            }
        }
        self.active = true;
        Ok(())
    }
    pub fn stop(&mut self) {
        self.active = false;
        // Revoke historical reads/writes before joining any producer thread.
        #[cfg(windows)]
        if let Some(analysis) = &self.analysis {
            analysis.request_stop();
        }
        // Join and release perception output before shutting down its GPU producer.
        #[cfg(windows)]
        if let Some(mut perception) = self.perception.take() {
            perception.stop();
            self.last_perception = Some(perception.snapshot());
        }
        #[cfg(windows)]
        if let Some(mut analysis) = self.analysis.take() {
            analysis.stop();
            self.last_analysis = analysis.snapshot();
        }
        #[cfg(windows)]
        if let Some(mut capture) = self.capture.take() {
            capture.stop();
            self.last = capture.snapshot();
        }
    }
    pub fn perception_statistics(&self) -> PerceptionStatistics {
        let mut stats = self
            .last_perception
            .clone()
            .unwrap_or_else(|| PerceptionStatistics::stopped(self.perception_config));
        #[cfg(windows)]
        if let Some(engine) = &self.perception {
            stats = engine.snapshot();
        }
        if !self.selected.supports_continuous_gpu_frames() {
            stats.state = "Unavailable for Legacy Backend";
        }
        stats
    }
    #[cfg(windows)]
    pub fn analysis_snapshot(&self) -> crate::visual_analysis::Snapshot {
        let mut snapshot = self
            .analysis
            .as_ref()
            .map(|a| a.snapshot())
            .unwrap_or_else(|| self.last_analysis.clone());
        if !self.selected.supports_continuous_gpu_frames() {
            snapshot.statistics.state = "Unavailable for Legacy Backend";
            snapshot.temporal.state = "Unavailable for Legacy Backend";
        }
        snapshot
    }
    #[cfg(windows)]
    pub fn temporal_memory(&self) -> Option<crate::temporal_memory::TemporalMemory> {
        self.analysis.as_ref().map(|a| a.temporal_memory())
    }
    #[cfg(windows)]
    pub fn recent_gpu_cache(&self) -> Option<crate::recent_gpu_cache::RecentGpuFrameCache> {
        self.analysis.as_ref().map(|a| a.recent_gpu_cache())
    }
    #[cfg(windows)]
    pub fn event_memory(&self) -> Option<crate::visual_events::EventMemory> {
        self.analysis.as_ref().map(|a| a.event_memory())
    }
    #[cfg(windows)]
    pub fn statistics(&self) -> Statistics {
        self.capture
            .as_ref()
            .map(|c| c.snapshot())
            .unwrap_or_else(|| self.last.clone())
    }
    #[cfg(windows)]
    pub fn readback_for_developer_preview(&self) -> Result<image::RgbaImage, AppError> {
        self.capture
            .as_ref()
            .ok_or_else(|| {
                AppError::new(
                    "stopped",
                    "Start the companion with Screen Awareness and WGC enabled.",
                )
            })?
            .readback_for_developer_preview()
            .map_err(|e| AppError::new(e.code, e.message))
    }
}
impl Drop for CaptureManager {
    fn drop(&mut self) {
        self.stop();
    }
}

#[tauri::command]
pub fn capture_backend_select(
    state: tauri::State<'_, crate::commands::AppState>,
    backend: BackendKind,
) -> Result<(), AppError> {
    state
        .1
        .lock()
        .map_err(|_| AppError::new("capture_unavailable", "Capture state is unavailable."))?
        .select(backend)
}
#[tauri::command]
pub fn capture_backend_status(
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<serde_json::Value, AppError> {
    let manager = state
        .1
        .lock()
        .map_err(|_| AppError::new("capture_unavailable", "Capture state is unavailable."))?;
    #[cfg(windows)]
    let stats = serde_json::to_value(manager.statistics())
        .map_err(|_| AppError::new("capture_unavailable", "Capture diagnostics unavailable."))?;
    #[cfg(not(windows))]
    let stats = serde_json::Value::Null;
    #[cfg(windows)]
    let analysis = serde_json::to_value(manager.analysis_snapshot())
        .map_err(|_| AppError::new("analysis_unavailable", "Analysis diagnostics unavailable."))?;
    #[cfg(not(windows))]
    let analysis = serde_json::Value::Null;
    Ok(
        serde_json::json!({"backend":manager.selected,"wgcAvailable":cfg!(windows),"gpuFrames":manager.selected.supports_continuous_gpu_frames(),"statistics":stats,"perception":manager.perception_statistics(),"analysis":analysis}),
    )
}
#[tauri::command]
pub fn perception_configure(
    state: tauri::State<'_, crate::commands::AppState>,
    target_fps: u32,
) -> Result<(), AppError> {
    state
        .1
        .lock()
        .map_err(|_| AppError::new("capture_unavailable", "Capture state is unavailable."))?
        .configure_perception(target_fps)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    image_base64: String,
    width: u32,
    height: u32,
}
#[tauri::command]
pub async fn recent_gpu_preview(
    state: tauri::State<'_, crate::commands::AppState>,
    selection: String,
    cache_generation: u64,
) -> Result<serde_json::Value, AppError> {
    #[cfg(not(windows))]
    {
        let _ = (state, selection, cache_generation);
        Err(AppError::new("unsupported", "GPU cache requires Windows."))
    }
    #[cfg(windows)]
    {
        let cache = state
            .1
            .lock()
            .map_err(|_| AppError::new("cache_unavailable", "GPU cache unavailable."))?
            .recent_gpu_cache()
            .ok_or_else(|| AppError::new("cache_empty", "No recent GPU frames available."))?;
        tauri::async_runtime::spawn_blocking(move || {
            use base64::Engine;
            use image::ImageEncoder;
            let expired = || AppError::new("cache_expired", "This recent GPU frame is no longer available.");
            let lease = match selection.as_str() {
                "latest" => cache.latest(),
                "oldest" => cache.oldest(),
                _ => return Err(AppError::new("invalid_selection", "Choose Latest or Oldest.")),
            }.ok_or_else(expired)?;
            let m = lease.metadata();
            if m.id.cache_generation != cache_generation {
                return Err(expired());
            }
            let preview = cache.readback_for_preview(&lease).map_err(|e| match e {
                crate::recent_gpu_cache::CacheError::Busy => AppError::new("cache_busy", "A full-resolution preview is already in progress."),
                _ => expired(),
            })?;
            let mut encoded = Vec::new();
            image::codecs::png::PngEncoder::new(&mut encoded)
                .write_image(&preview.image, m.width, m.height, image::ColorType::Rgba8)
                .map_err(|_| AppError::new("encoding_failed", "GPU cache preview encoding failed."))?;
            let base64 = base64::engine::general_purpose::STANDARD.encode(&encoded);
            encoded.fill(0);
            cache.get(m.id).map_err(|_| expired())?;
            Ok(serde_json::json!({
                "imageBase64": base64, "width": m.width, "height": m.height, "id": m.id,
                "sourceFrameId": m.source_frame_id, "ageMs": m.source_timestamp.elapsed().as_secs_f64() * 1000.
            }))
        })
        .await
        .map_err(|_| AppError::new("cache_worker_failed", "GPU cache preview unavailable."))?
    }
}
#[tauri::command]
pub fn recent_gpu_correlate(
    state: tauri::State<'_, crate::commands::AppState>,
    age_ms: u32,
    maximum_distance_ms: u32,
) -> Result<serde_json::Value, AppError> {
    if age_ms > 5000 || maximum_distance_ms > 1000 {
        return Err(AppError::new(
            "invalid_range",
            "Choose a sample within five seconds and a correlation tolerance up to one second.",
        ));
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        Err(AppError::new("unsupported", "GPU cache requires Windows."))
    }
    #[cfg(windows)]
    {
        let (history, cache) = {
            let manager = state
                .1
                .lock()
                .map_err(|_| AppError::new("cache_unavailable", "Visual memory unavailable."))?;
            (manager.temporal_memory(), manager.recent_gpu_cache())
        };
        let now = std::time::Instant::now();
        let sample = history
            .and_then(|h| h.sample_ago(std::time::Duration::from_millis(age_ms as u64), now));
        let matched = sample.zip(cache).and_then(|(sample, cache)| {
            cache.correlate(
                sample.into(),
                std::time::Duration::from_millis(maximum_distance_ms as u64),
            )
        });
        Ok(match matched {
            Some(m) => {
                serde_json::json!({"kind":m.kind,"deltaMs":m.delta.as_secs_f64()*1000.,"id":m.frame.metadata().id,"sourceFrameId":m.frame.metadata().source_frame_id})
            }
            None => serde_json::Value::Null,
        })
    }
}
#[tauri::command]
pub async fn promoted_keyframe_preview(
    state: tauri::State<'_, crate::commands::AppState>,
    generation: u64,
    sequence: u64,
) -> Result<serde_json::Value, AppError> {
    #[cfg(not(windows))]
    {
        let _ = (state, generation, sequence);
        Err(AppError::new(
            "unsupported",
            "GPU keyframes require Windows.",
        ))
    }
    #[cfg(windows)]
    {
        let memory = state
            .1
            .lock()
            .map_err(|_| AppError::new("keyframe_unavailable", "Visual memory unavailable."))?
            .event_memory()
            .ok_or_else(|| {
                AppError::new("keyframe_unavailable", "No promoted keyframes available.")
            })?;
        tauri::async_runtime::spawn_blocking(move || {
            use base64::Engine;
            use image::ImageEncoder;
            let expired = || AppError::new("keyframe_expired", "This promoted keyframe is no longer available.");
            let cache = memory.keyframes();
            let id = crate::visual_events::KeyframeId { generation, sequence };
            let lease: crate::promoted_keyframes::KeyframeLease = cache.keyframe(id, std::time::Instant::now()).ok_or_else(expired)?;
            let m = lease.metadata();
            let preview = cache.preview(id).map_err(|_| expired())?;
            let mut encoded = Vec::new();
            image::codecs::png::PngEncoder::new(&mut encoded)
                .write_image(&preview.image, m.source.width, m.source.height, image::ColorType::Rgba8)
                .map_err(|_| AppError::new("encoding_failed", "Keyframe preview encoding failed."))?;
            let base64 = base64::engine::general_purpose::STANDARD.encode(&encoded);
            encoded.fill(0);
            if !lease.is_available() { return Err(expired()); }
            Ok(serde_json::json!({
                "id": m.id, "event": m.event, "kind": m.kind, "status": m.status,
                "width": m.source.width, "height": m.source.height, "sourceFrameId": m.source.source_frame_id,
                "ageMs": m.source.source_timestamp.elapsed().as_secs_f64()*1000., "imageBase64": base64
            }))
        }).await.map_err(|_| AppError::new("keyframe_unavailable", "Keyframe preview unavailable."))?
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporalPreview {
    preview: Preview,
    id: crate::temporal_memory::SampleId,
    source_frame_id: u64,
    age_ms: f64,
    classification: Option<crate::visual_analysis::Classification>,
}
#[tauri::command]
pub async fn temporal_sample_preview(
    state: tauri::State<'_, crate::commands::AppState>,
    age_ms: u32,
    temporal_generation: u64,
) -> Result<TemporalPreview, AppError> {
    if age_ms > 5000 {
        return Err(AppError::new(
            "invalid_age",
            "Choose a sample within five seconds.",
        ));
    }
    #[cfg(not(windows))]
    {
        let _ = (state, temporal_generation);
        Err(AppError::new(
            "unsupported",
            "Temporal capture requires Windows.",
        ))
    }
    #[cfg(windows)]
    {
        let memory = state
            .1
            .lock()
            .map_err(|_| AppError::new("temporal_unavailable", "Temporal history unavailable."))?
            .temporal_memory()
            .ok_or_else(|| AppError::new("temporal_empty", "No temporal history is available."))?;
        tauri::async_runtime::spawn_blocking(move || {
            encode_temporal_preview(&memory, age_ms, temporal_generation)
        })
        .await
        .map_err(|_| AppError::new("temporal_worker_failed", "Temporal preview unavailable."))?
    }
}
#[cfg(windows)]
pub(crate) fn encode_temporal_preview(
    memory: &crate::temporal_memory::TemporalMemory,
    age_ms: u32,
    temporal_generation: u64,
) -> Result<TemporalPreview, AppError> {
    use base64::Engine;
    use image::ImageEncoder;
    use std::time::{Duration, Instant};
    let expired = || {
        AppError::new(
            "temporal_expired",
            "This temporal sample is no longer available.",
        )
    };
    let now = Instant::now();
    let meta = memory
        .sample_ago(Duration::from_millis(age_ms as u64), now)
        .ok_or_else(expired)?;
    if meta.id.temporal_generation != temporal_generation {
        return Err(expired());
    }
    let sample = memory.visual_for(meta.id, now).map_err(|_| expired())?;
    // Encode one explicitly requested low-resolution copy, with no ring,
    // manager or D3D lock held. Never persist it or send it to a provider.
    let mut encoded = Vec::new();
    image::codecs::png::PngEncoder::new(&mut encoded)
        .write_image(
            &sample.luma,
            meta.geometry.analysis_width,
            meta.geometry.analysis_height,
            image::ColorType::L8,
        )
        .map_err(|_| AppError::new("encoding_failed", "Temporal preview encoding failed."))?;
    let image_base64 = base64::engine::general_purpose::STANDARD.encode(&encoded);
    encoded.fill(0);
    memory
        .metadata_for(meta.id, Instant::now())
        .map_err(|_| expired())?;
    Ok(TemporalPreview {
        preview: Preview {
            image_base64,
            width: meta.geometry.analysis_width,
            height: meta.geometry.analysis_height,
        },
        id: meta.id,
        source_frame_id: meta.source_frame_id,
        age_ms: now
            .saturating_duration_since(meta.source_timestamp)
            .as_secs_f64()
            * 1000.,
        classification: meta.change.map(|m| m.classification),
    })
}
#[tauri::command]
pub async fn capture_wgc_test_frame(
    state: tauri::State<'_, crate::commands::AppState>,
) -> Result<Preview, AppError> {
    let manager = state.1.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = manager
            .lock()
            .map_err(|_| AppError::new("capture_unavailable", "Capture state unavailable."))?;
        #[cfg(windows)]
        let image = manager.readback_for_developer_preview()?;
        #[cfg(not(windows))]
        {
            let _ = manager;
            return Err(AppError::new("unsupported", "WGC requires Windows."));
        }
        #[cfg(windows)]
        {
            use base64::Engine;
            let (width, height) = image.dimensions();
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(image)
                .write_to(&mut bytes, image::ImageOutputFormat::Png)
                .map_err(|_| AppError::new("encoding_failed", "Preview encoding failed."))?;
            Ok(Preview {
                image_base64: base64::engine::general_purpose::STANDARD.encode(bytes.into_inner()),
                width,
                height,
            })
        }
    })
    .await
    .map_err(|_| AppError::new("capture_worker_failed", "Preview worker failed."))?
}
