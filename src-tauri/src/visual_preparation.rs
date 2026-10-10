use crate::error::AppError;
use image::{imageops::FilterType, RgbImage};
use serde::Deserialize;
use zeroize::{Zeroize, Zeroizing};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualConfig {
    pub max_dimension: u32,
    pub jpeg_quality: u8,
    pub max_encoded_bytes: usize,
}
pub fn config() -> VisualConfig {
    serde_json::from_str(include_str!(
        "../../src/providers/realtime/visual/config.json"
    ))
    .expect("compiled visual configuration")
}
pub fn resize(rgb: RgbImage) -> RgbImage {
    let limit = config().max_dimension;
    let (width, height) = rgb.dimensions();
    if width.max(height) <= limit {
        return rgb;
    }
    let ratio = limit as f64 / width.max(height) as f64;
    image::imageops::resize(
        &rgb,
        (width as f64 * ratio).round().max(1.0) as u32,
        (height as f64 * ratio).round().max(1.0) as u32,
        FilterType::Lanczos3,
    )
}
pub fn validate_size(size: usize, limit: usize) -> Result<(), AppError> {
    if size > limit.min(config().max_encoded_bytes) {
        return Err(AppError::new(
            "image_too_large",
            "Prepared image exceeds the current connection limit. No image was sent.",
        ));
    }
    Ok(())
}

pub struct EncodedOverview {
    pub bytes: Zeroizing<Vec<u8>>,
    pub width: u32,
    pub height: u32,
}

/// Fit an overview of the same owned pixels to the negotiated transport budget.
/// Exact PNG detail remains lossless and never uses this preparation path.
pub fn encode_overview(
    mut rgb: RgbImage,
    limit: usize,
    mut check: impl FnMut() -> Result<(), AppError>,
) -> Result<EncodedOverview, AppError> {
    let config = config();
    let limit = limit.min(config.max_encoded_bytes);
    // Preserve enough context to remain useful; never shrink to a token image
    // merely to report successful delivery over an unusably small connection.
    let minimum_dimension = rgb.width().max(rgb.height()).min(512);
    let mut quality = config.jpeg_quality;
    let mut bytes = Zeroizing::new(Vec::new());
    let result = (|| {
        check()?;
        if rgb.width().max(rgb.height()) > config.max_dimension {
            resize_owned(&mut rgb, config.max_dimension, FilterType::Lanczos3);
        }
        // At most five encodes: configured quality, lower quality, a measured
        // resize, lower quality again, and one final measured resize.
        for attempt in 0..5 {
            check()?;
            bytes.zeroize();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut *bytes, quality)
                .encode(
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    image::ColorType::Rgb8,
                )
                .map_err(|_| {
                    AppError::new(
                        "encoding_failed",
                        "The selected image could not be encoded.",
                    )
                })?;
            check()?;
            if bytes.len() <= limit {
                return Ok(EncodedOverview {
                    bytes: std::mem::take(&mut bytes),
                    width: rgb.width(),
                    height: rgb.height(),
                });
            }
            match attempt {
                0 => quality = quality.min(70),
                1 | 3 => {
                    let dimension = rgb.width().max(rgb.height());
                    let scale = ((limit as f64 / bytes.len() as f64).sqrt() * 0.85).min(0.85);
                    let target = ((dimension as f64 * scale).floor() as u32).max(minimum_dimension);
                    if target < dimension {
                        check()?;
                        resize_owned(&mut rgb, target, FilterType::Triangle);
                    }
                }
                2 => quality = quality.min(55),
                _ => {}
            }
        }
        validate_size(bytes.len(), limit)?;
        unreachable!("oversized overview must be rejected")
    })();
    rgb.as_mut().zeroize();
    result
}

fn resize_owned(rgb: &mut RgbImage, maximum: u32, filter: FilterType) {
    let ratio = maximum as f64 / rgb.width().max(rgb.height()) as f64;
    let width = (rgb.width() as f64 * ratio).round().max(1.) as u32;
    let height = (rgb.height() as f64 * ratio).round().max(1.) as u32;
    let source = image::DynamicImage::ImageRgb8(std::mem::take(rgb));
    let resized = source.resize_exact(width, height, filter).into_rgb8();
    source.into_rgb8().as_mut().zeroize();
    *rgb = resized;
}
