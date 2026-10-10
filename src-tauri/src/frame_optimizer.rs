use crate::{error::AppError, observer::Region};
use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    ImageEncoder, RgbImage,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum FrameKind {
    #[default]
    Context,
    Detail,
}
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameRequest {
    #[serde(default)]
    pub kind: FrameKind,
    pub region: Option<Region>,
}
pub struct Optimized {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub region: Region,
    pub encoding: &'static str,
}
pub fn clip(region: Region, w: u32, h: u32) -> Result<Region, AppError> {
    if region.width == 0 || region.height == 0 || region.x >= w || region.y >= h {
        return Err(AppError::new(
            "invalid_roi",
            "Region must intersect the display and have positive dimensions.",
        ));
    }
    Ok(Region {
        width: region.width.min(w - region.x),
        height: region.height.min(h - region.y),
        ..region
    })
}
pub fn optimize(
    rgb: RgbImage,
    request: &FrameRequest,
    resize: bool,
) -> Result<Optimized, AppError> {
    let (w, h) = rgb.dimensions();
    let region = if request.kind == FrameKind::Detail {
        clip(
            request.region.unwrap_or(Region {
                x: w.saturating_sub(1280) / 2,
                y: h.saturating_sub(720) / 2,
                width: w.min(1280),
                height: h.min(720),
            }),
            w,
            h,
        )?
    } else {
        Region {
            x: 0,
            y: 0,
            width: w,
            height: h,
        }
    };
    let rgb = if request.kind == FrameKind::Detail {
        image::imageops::crop_imm(&rgb, region.x, region.y, region.width, region.height).to_image()
    } else if resize {
        crate::visual_preparation::resize(rgb)
    } else {
        rgb
    };
    let (width, height) = rgb.dimensions();
    let mut bytes = Vec::new();
    let encoding = if request.kind == FrameKind::Detail {
        PngEncoder::new(&mut bytes).write_image(rgb.as_raw(), width, height, image::ColorType::Rgb8)
    } else {
        JpegEncoder::new_with_quality(&mut bytes, crate::visual_preparation::config().jpeg_quality)
            .encode(rgb.as_raw(), width, height, image::ColorType::Rgb8)
    };
    encoding.map_err(|_| AppError::new("encoding_failed", "Could not encode screenshot."))?;
    Ok(Optimized {
        bytes,
        width,
        height,
        region,
        encoding: if request.kind == FrameKind::Detail {
            "png"
        } else {
            "jpeg"
        },
    })
}
