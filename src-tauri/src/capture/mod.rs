use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::frame_optimizer::{optimize, FrameKind, FrameRequest};
use crate::observer::Region;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::DynamicImage;
use serde::Serialize;

use crate::change_detection::{
    validate_threshold, AnalysisFrame, ChangeAnalysis, ChangeDetector, MeanAbsoluteDifference,
};
use crate::{error::AppError, platform::screen_capture::ScreenCaptureService};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedFrame {
    image_base64: String,
    width: u32,
    height: u32,
    original_width: u32,
    original_height: u32,
    timestamp_unix_ms: u64,
    encoded_size_bytes: usize,
    pub stabilization_wait_ms: f64,
    capture_duration_ms: f64,
    encoding_duration_ms: f64,
    analysis_duration_ms: f64,
    total_duration_ms: f64,
    pub analysis: ChangeAnalysis,
    encoding: &'static str,
    kind: FrameKind,
    source_region: Region,
}

pub fn capture(
    service: &impl ScreenCaptureService,
    previous: Option<&AnalysisFrame>,
    threshold: f64,
) -> Result<(CapturedFrame, AnalysisFrame), AppError> {
    capture_prepared(service, previous, threshold, None)
}

pub fn capture_prepared(
    service: &impl ScreenCaptureService,
    previous: Option<&AnalysisFrame>,
    threshold: f64,
    visual_byte_limit: Option<usize>,
) -> Result<(CapturedFrame, AnalysisFrame), AppError> {
    capture_optimized(
        service,
        previous,
        threshold,
        visual_byte_limit,
        &FrameRequest::default(),
    )
}
pub fn capture_optimized(
    service: &impl ScreenCaptureService,
    previous: Option<&AnalysisFrame>,
    threshold: f64,
    visual_byte_limit: Option<usize>,
    request: &FrameRequest,
) -> Result<(CapturedFrame, AnalysisFrame), AppError> {
    validate_threshold(threshold)?;
    let started = Instant::now();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            AppError::technical("clock_error", "The system clock is invalid.", error)
        })?;
    let capture_started = Instant::now();
    let rgba = service.capture_primary_screen()?;
    let (original_width, original_height) = rgba.dimensions();
    let capture_duration_ms = capture_started.elapsed().as_secs_f64() * 1000.0;
    let analysis_started = Instant::now();
    let current = AnalysisFrame::from_rgba(&rgba)?;
    let analysis = MeanAbsoluteDifference.compare(previous, &current, threshold)?;
    let analysis_duration_ms = analysis_started.elapsed().as_secs_f64() * 1000.0;
    let encoding_started = Instant::now();
    let rgb = DynamicImage::ImageRgba8(rgba).into_rgb8();
    let optimized = optimize(rgb, request, visual_byte_limit.is_some())?;
    let (width, height) = (optimized.width, optimized.height);
    let bytes = optimized.bytes;
    let encoded_size_bytes = bytes.len();
    if let Some(limit) = visual_byte_limit {
        crate::visual_preparation::validate_size(encoded_size_bytes, limit)?;
    }
    let image_base64 = STANDARD.encode(&bytes);
    let encoding_duration_ms = encoding_started.elapsed().as_secs_f64() * 1000.0;
    Ok((
        CapturedFrame {
            image_base64,
            width,
            height,
            original_width,
            original_height,
            timestamp_unix_ms: timestamp.as_millis() as u64,
            encoded_size_bytes,
            stabilization_wait_ms: 0.,
            capture_duration_ms,
            encoding_duration_ms,
            analysis_duration_ms,
            total_duration_ms: started.elapsed().as_secs_f64() * 1000.0,
            analysis,
            encoding: optimized.encoding,
            kind: request.kind,
            source_region: optimized.region,
        },
        current,
    ))
}
