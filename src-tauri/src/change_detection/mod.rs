use image::{
    imageops::{resize, FilterType},
    DynamicImage, RgbImage, RgbaImage,
};
use serde::Serialize;

use crate::error::AppError;

const ANALYSIS_WIDTH: u32 = 160;
const ANALYSIS_HEIGHT: u32 = 90;
const DEFAULT_THRESHOLD: f64 = 0.05;
const MAX_THRESHOLD: f64 = 0.5;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionConfig {
    pub default_threshold: f64,
    pub min_threshold: f64,
    pub max_threshold: f64,
    pub threshold_step: f64,
}

pub fn config() -> DetectionConfig {
    DetectionConfig {
        default_threshold: DEFAULT_THRESHOLD,
        min_threshold: 0.0,
        max_threshold: MAX_THRESHOLD,
        threshold_step: 0.005,
    }
}

pub fn validate_threshold(threshold: f64) -> Result<(), AppError> {
    if !threshold.is_finite() || !(0.0..=MAX_THRESHOLD).contains(&threshold) {
        return Err(AppError::new(
            "invalid_threshold",
            "Change threshold must be a finite number between 0 and 0.5.",
        ));
    }
    Ok(())
}

#[derive(Clone)]
pub struct AnalysisFrame {
    pixels: RgbImage,
    source_dimensions: (u32, u32),
}

impl AnalysisFrame {
    pub fn from_rgba(source: &RgbaImage) -> Result<Self, AppError> {
        if source.width() == 0 || source.height() == 0 {
            return Err(AppError::new(
                "invalid_frame",
                "Cannot analyze an empty image.",
            ));
        }
        // Filter raw pixels before JPEG encoding; retain no full-resolution history.
        let small = resize(
            source,
            ANALYSIS_WIDTH,
            ANALYSIS_HEIGHT,
            FilterType::Triangle,
        );
        Ok(Self {
            pixels: DynamicImage::ImageRgba8(small).into_rgb8(),
            source_dimensions: source.dimensions(),
        })
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Baseline,
    ResolutionChanged,
    NoMeaningfulChange,
    MeaningfulChange,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeAnalysis {
    pub previous_frame_available: bool,
    pub change_score: Option<f64>,
    pub threshold: f64,
    pub decision: Decision,
    pub analysis_width: u32,
    pub analysis_height: u32,
}

pub trait ChangeDetector {
    fn compare(
        &self,
        previous: Option<&AnalysisFrame>,
        current: &AnalysisFrame,
        threshold: f64,
    ) -> Result<ChangeAnalysis, AppError>;
}

pub struct MeanAbsoluteDifference;

impl ChangeDetector for MeanAbsoluteDifference {
    fn compare(
        &self,
        previous: Option<&AnalysisFrame>,
        current: &AnalysisFrame,
        threshold: f64,
    ) -> Result<ChangeAnalysis, AppError> {
        validate_threshold(threshold)?;
        let (change_score, decision) = match previous {
            None => (None, Decision::Baseline),
            Some(previous) if previous.source_dimensions != current.source_dimensions => {
                (None, Decision::ResolutionChanged)
            }
            Some(previous) => {
                let difference: u64 = previous
                    .pixels
                    .as_raw()
                    .iter()
                    .zip(current.pixels.as_raw())
                    .map(|(a, b)| u64::from(a.abs_diff(*b)))
                    .sum();
                let score = difference as f64 / (current.pixels.as_raw().len() as f64 * 255.0);
                // Strict comparison keeps identical frames unchanged even at threshold zero.
                (
                    Some(score),
                    if score > threshold {
                        Decision::MeaningfulChange
                    } else {
                        Decision::NoMeaningfulChange
                    },
                )
            }
        };
        Ok(ChangeAnalysis {
            previous_frame_available: previous.is_some(),
            change_score,
            threshold,
            decision,
            analysis_width: ANALYSIS_WIDTH,
            analysis_height: ANALYSIS_HEIGHT,
        })
    }
}
