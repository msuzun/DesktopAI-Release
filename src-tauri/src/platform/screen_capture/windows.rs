use super::{CapturedBitmap, ScreenCaptureService};
use crate::error::AppError;

pub struct NativeScreenCapture;

impl ScreenCaptureService for NativeScreenCapture {
    fn capture_primary_screen(&self) -> Result<image::RgbaImage, AppError> {
        // Reuse the native GDI capture path, including physical-pixel sizing,
        // primary monitor selection, BGRA-to-RGBA conversion and RAII cleanup.
        CapturedBitmap::primary(256 * 1024 * 1024)?.read()
    }
}
