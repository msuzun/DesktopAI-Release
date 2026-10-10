use super::{
    device::Device,
    error::{CaptureError, CaptureResult, Result},
    frame::GpuFrameHandle,
};
use windows::Win32::Graphics::Direct3D11::*;

pub fn unpack_bgra(
    bytes: &[u8],
    width: u32,
    height: u32,
    pitch: usize,
) -> Result<image::RgbaImage> {
    let row = (width as usize)
        .checked_mul(4)
        .ok_or_else(|| CaptureError::new("invalid_layout"))?;
    let size = pitch
        .checked_mul(height as usize)
        .ok_or_else(|| CaptureError::new("invalid_layout"))?;
    if width == 0 || height == 0 || pitch < row || bytes.len() < size {
        return Err(CaptureError::new("invalid_layout"));
    }
    let mut image = image::RgbaImage::new(width, height);
    for (source, target) in bytes[..size]
        .chunks_exact(pitch)
        .zip(image.as_mut().chunks_exact_mut(row))
    {
        for (b, r) in source[..row]
            .chunks_exact(4)
            .zip(target.chunks_exact_mut(4))
        {
            r.copy_from_slice(&[b[2], b[1], b[0], 255]);
        }
    }
    Ok(image)
}

// Explicit expensive boundary. Called only on a manual request, on the device worker.
pub fn readback_for_developer_preview(
    device: &Device,
    frame: &GpuFrameHandle,
) -> Result<image::RgbaImage> {
    if frame.pixel_format != windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM {
        return Err(CaptureError::new("pixel_format"));
    }
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe {
        frame.texture.GetDesc(&mut desc);
    }
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    desc.MiscFlags = 0;
    let staging = device.texture(&desc)?;
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    // Same immediate context orders CopyResource before Map; Map waits for GPU completion.
    unsafe {
        device.context.CopyResource(&staging, &frame.texture);
        device
            .context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
    }
    .capture("readback")?;
    struct Mapping<'a>(&'a Device, &'a ID3D11Texture2D);
    impl Drop for Mapping<'_> {
        fn drop(&mut self) {
            unsafe {
                self.0.context.Unmap(self.1, 0);
            }
        }
    }
    let _mapping = Mapping(device, &staging);
    let size = (mapped.RowPitch as usize)
        .checked_mul(frame.height as usize)
        .filter(|n| *n <= isize::MAX as usize)
        .ok_or_else(|| CaptureError::new("invalid_layout"))?;
    if mapped.pData.is_null() {
        return Err(CaptureError::new("invalid_layout"));
    }
    // Map guarantees RowPitch * texture height readable until Unmap; frame dimensions match desc.
    let bytes = unsafe { std::slice::from_raw_parts(mapped.pData.cast::<u8>(), size) };
    unpack_bgra(bytes, frame.width, frame.height, mapped.RowPitch as usize)
}
