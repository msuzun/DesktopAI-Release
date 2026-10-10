//! One bounded on-demand bitmap. Selection copies the desktop; CPU readback
//! and pixel conversion happen only when the selected turn is prepared.
use crate::error::AppError;
use std::{mem::size_of, time::Instant};
use windows::{
    core::{w, PCWSTR},
    Win32::{Foundation::POINT, Graphics::Gdi::*},
};
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, AppError>;
fn failure() -> AppError {
    AppError::new(
        "readback_failed",
        "The selected desktop image could not be read.",
    )
}
struct Dc(HDC);
impl Dc {
    fn checked(value: HDC) -> Result<Self> {
        if value.is_invalid() {
            Err(failure())
        } else {
            Ok(Self(value))
        }
    }
}
impl Drop for Dc {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteDC(self.0);
        }
    }
}
struct Bitmap(HBITMAP);
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.0.into());
        }
    }
}
// A bitmap is a process-owned GDI object, not a thread-owned DC. It is always
// deselected and flushed before transfer. CapturedBitmap only exposes read via
// &mut self; the visual asset serializes read/revoke/drop with its mutex.
// https://learn.microsoft.com/en-us/windows/win32/procthread/multiple-threads-and-gdi-objects
unsafe impl Send for Bitmap {}

struct Selected<'a> {
    dc: &'a Dc,
    previous: HGDIOBJ,
}
impl Drop for Selected<'_> {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc.0, self.previous);
        }
    }
}

pub(crate) struct CapturedBitmap {
    bitmap: Bitmap,
    pub width: u32,
    pub height: u32,
    pub captured_at: Instant,
}

fn byte_size(width: i32, height: i32, limit: u64) -> Result<usize> {
    if width <= 0 || height <= 0 {
        return Err(failure());
    }
    (width as u64)
        .checked_mul(height as u64)
        .and_then(|n| n.checked_mul(4))
        .filter(|n| *n <= limit && *n <= isize::MAX as u64)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| {
            AppError::new(
                "current_unavailable",
                "The desktop image exceeds the snapshot budget.",
            )
        })
}

impl CapturedBitmap {
    pub fn primary(limit: u64) -> Result<Self> {
        // Query the current primary monitor each time: no stale display/DC cache
        // across resolution, DPI, primary-monitor or session changes.
        let monitor = unsafe { MonitorFromPoint(POINT::default(), MONITOR_DEFAULTTOPRIMARY) };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if monitor.is_invalid()
            || !unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) }.as_bool()
        {
            return Err(failure());
        }
        let display = Dc::checked(unsafe {
            CreateDCW(
                w!("DISPLAY"),
                PCWSTR(info.szDevice.as_ptr()),
                PCWSTR::null(),
                None,
            )
        })?;
        // Physical device pixels, including when the caller is DPI-unaware.
        let width = unsafe { GetDeviceCaps(Some(display.0), DESKTOPHORZRES) };
        let height = unsafe { GetDeviceCaps(Some(display.0), DESKTOPVERTRES) };
        byte_size(width, height, limit)?;
        let bitmap = Bitmap(unsafe { CreateCompatibleBitmap(display.0, width, height) });
        if bitmap.0.is_invalid() {
            return Err(failure());
        }
        let memory = Dc::checked(unsafe { CreateCompatibleDC(Some(display.0)) })?;
        let previous = unsafe { SelectObject(memory.0, bitmap.0.into()) };
        if previous.is_invalid() {
            return Err(failure());
        }
        let selected = Selected {
            dc: &memory,
            previous,
        };
        unsafe {
            BitBlt(
                memory.0,
                0,
                0,
                width,
                height,
                Some(display.0),
                0,
                0,
                SRCCOPY | CAPTUREBLT | NOMIRRORBITMAP,
            )
        }
        .map_err(|_| failure())?;
        // Complete GDI's batch before recording the observation time or letting
        // a different thread read/delete the object. Never backdate the image.
        if !unsafe { GdiFlush() }.as_bool() {
            return Err(failure());
        }
        let captured_at = Instant::now();
        drop(selected); // GetDIBits requires a bitmap not selected into any DC.
        Ok(Self {
            bitmap,
            width: width as u32,
            height: height as u32,
            captured_at,
        })
    }

    pub fn read(&mut self) -> Result<image::RgbaImage> {
        let dc = Dc::checked(unsafe { CreateCompatibleDC(None) })?;
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: self.width as i32,
                biHeight: -(self.height as i32), // top-down; no second flipped image
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let size = byte_size(self.width as i32, self.height as i32, u64::MAX)?;
        let mut bytes = Zeroizing::new(vec![0u8; size]);
        let rows = unsafe {
            GetDIBits(
                dc.0,
                self.bitmap.0,
                0,
                self.height,
                Some(bytes.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        if rows != self.height as i32 {
            return Err(failure());
        }
        for pixel in bytes.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        image::RgbaImage::from_raw(self.width, self.height, std::mem::take(&mut *bytes))
            .ok_or_else(failure)
    }
}
