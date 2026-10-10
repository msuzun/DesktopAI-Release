use crate::error::AppError;

#[cfg(windows)]
mod frozen_bitmap;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use frozen_bitmap::CapturedBitmap;
#[cfg(windows)]
pub use windows::NativeScreenCapture;
#[cfg(windows)]
pub mod wgc;

pub trait ScreenCaptureService {
    fn capture_primary_screen(&self) -> Result<image::RgbaImage, AppError>;
}

#[cfg(not(windows))]
pub struct NativeScreenCapture;

#[cfg(not(windows))]
impl ScreenCaptureService for NativeScreenCapture {
    fn capture_primary_screen(&self) -> Result<image::RgbaImage, AppError> {
        Err(AppError::new(
            "unsupported_platform",
            "Desktop AI Companion currently supports Windows only.",
        ))
    }
}
