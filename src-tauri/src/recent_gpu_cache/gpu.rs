use super::*;
use std::sync::atomic::AtomicBool;

pub(super) fn validate(f: &GpuFrameHandle) -> Result<ID3D11Device> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe {
        f.texture.GetDesc(&mut desc);
    }
    if f.pixel_format != DXGI_FORMAT_B8G8R8A8_UNORM {
        return Err(CacheError::UnsupportedFormat);
    }
    if desc.Format != f.pixel_format
        || desc.Width != f.width
        || desc.Height != f.height
        || desc.MipLevels != 1
        || desc.ArraySize != 1
        || desc.SampleDesc.Count != 1
        || desc.SampleDesc.Quality != 0
    {
        return Err(CacheError::InvalidSource);
    }
    let device = unsafe { f.texture.GetDevice() }.map_err(|_| CacheError::DeviceLost)?;
    unsafe { device.GetDeviceRemovedReason() }.map_err(|_| CacheError::DeviceLost)?;
    Ok(device)
}
struct ContextGuard(ID3D11Multithread);
impl ContextGuard {
    fn enter(context: &ID3D11DeviceContext) -> Result<Self> {
        let mt: ID3D11Multithread = context.cast().map_err(|_| CacheError::InvalidSource)?;
        if !unsafe { mt.GetMultithreadProtected() }.as_bool() {
            return Err(CacheError::InvalidSource);
        }
        unsafe {
            mt.Enter();
        }
        Ok(Self(mt))
    }
}
impl Drop for ContextGuard {
    fn drop(&mut self) {
        unsafe {
            self.0.Leave();
        }
    }
}
static PREVIEW_BUSY: AtomicBool = AtomicBool::new(false);
struct PreviewPermit;
impl Drop for PreviewPermit {
    fn drop(&mut self) {
        PREVIEW_BUSY.store(false, Ordering::Release);
    }
}
pub struct PreviewImage {
    pub image: image::RgbaImage,
    _permit: PreviewPermit,
}
// Shared only by explicit developer previews of Tier B and Tier C. No raw
// texture escapes the revocable lease; the global permit bounds both tiers.
pub trait PreviewSource {
    fn dimensions(&self) -> (u32, u32);
    fn device(&self) -> Result<ID3D11Device>;
    fn copy_to(&self, destination: &ID3D11Texture2D) -> Result<()>;
    fn is_available(&self) -> bool;
}
pub fn copy_texture(source: &ID3D11Texture2D, destination: &ID3D11Texture2D) -> Result<()> {
    let device = unsafe { source.GetDevice() }.map_err(|_| CacheError::DeviceLost)?;
    let mut a = D3D11_TEXTURE2D_DESC::default();
    let mut b = D3D11_TEXTURE2D_DESC::default();
    unsafe {
        source.GetDesc(&mut a);
        destination.GetDesc(&mut b);
    }
    if unsafe { destination.GetDevice() }.map_err(|_| CacheError::IncompatibleDevice)? != device
        || a.Width != b.Width
        || a.Height != b.Height
        || a.Format != b.Format
        || a.MipLevels != b.MipLevels
        || a.ArraySize != b.ArraySize
        || a.SampleDesc.Count != b.SampleDesc.Count
        || a.SampleDesc.Quality != b.SampleDesc.Quality
        || b.Usage == D3D11_USAGE_IMMUTABLE
    {
        return Err(CacheError::IncompatibleDevice);
    }
    let context = unsafe { device.GetImmediateContext() }.map_err(|_| CacheError::DeviceLost)?;
    let _guard = ContextGuard::enter(&context)?;
    unsafe {
        context.CopyResource(destination, source);
        device.GetDeviceRemovedReason()
    }
    .map_err(|_| CacheError::DeviceLost)
}
impl Drop for PreviewImage {
    fn drop(&mut self) {
        self.image.as_mut().fill(0);
    }
}

impl FrameLease {
    // A device clone conveys no screen texture. Consumers can allocate a separate
    // budgeted destination, then issue promotion through copy_to without exposing
    // the cache texture or extending its ownership beyond privacy revocation.
    pub fn device(&self) -> Result<ID3D11Device> {
        let frame = self.cell.frame.lock().unwrap_or_else(|e| e.into_inner());
        validate(frame.as_ref().ok_or(CacheError::Expired)?)
    }
    pub fn copy_to(&self, destination: &ID3D11Texture2D) -> Result<()> {
        let source = self.cell.frame.lock().unwrap_or_else(|e| e.into_inner());
        let source = source.as_ref().ok_or(CacheError::Expired)?;
        let device = validate(source)?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            destination.GetDesc(&mut desc);
        }
        if unsafe { destination.GetDevice() }.map_err(|_| CacheError::IncompatibleDevice)? != device
            || desc.Width != source.width
            || desc.Height != source.height
            || desc.Format != source.pixel_format
            || desc.MipLevels != 1
            || desc.ArraySize != 1
            || desc.SampleDesc.Count != 1
            || desc.SampleDesc.Quality != 0
            || desc.Usage == D3D11_USAGE_IMMUTABLE
        {
            return Err(CacheError::IncompatibleDevice);
        }
        let context =
            unsafe { device.GetImmediateContext() }.map_err(|_| CacheError::DeviceLost)?;
        let _guard = ContextGuard::enter(&context)?;
        unsafe {
            context.CopyResource(destination, &source.texture);
        }
        self.cell
            .counters
            .consumer_copies
            .fetch_add(1, Ordering::Relaxed);
        unsafe { device.GetDeviceRemovedReason() }.map_err(|_| CacheError::DeviceLost)
    }
    // Explicit diagnostic only. One process-wide permit bounds staging/CPU/PNG
    // work across rapid stop/restart, including the caller's encoding lifetime.
    pub(crate) fn readback(&self) -> Result<PreviewImage> {
        readback(self)
    }
}
impl PreviewSource for FrameLease {
    fn dimensions(&self) -> (u32, u32) {
        (self.metadata.width, self.metadata.height)
    }
    fn device(&self) -> Result<ID3D11Device> {
        FrameLease::device(self)
    }
    fn copy_to(&self, destination: &ID3D11Texture2D) -> Result<()> {
        FrameLease::copy_to(self, destination)
    }
    fn is_available(&self) -> bool {
        FrameLease::is_available(self)
    }
}
pub fn readback(source: &impl PreviewSource) -> Result<PreviewImage> {
    if PREVIEW_BUSY
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(CacheError::Busy);
    }
    let permit = PreviewPermit;
    let device = source.device()?;
    let context = unsafe { device.GetImmediateContext() }.map_err(|_| CacheError::DeviceLost)?;
    let (width, height) = source.dimensions();
    let mut staging = None;
    unsafe {
        device.CreateTexture2D(
            &D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_STAGING,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                ..Default::default()
            },
            None,
            Some(&mut staging),
        )
    }
    .map_err(|_| CacheError::AllocationFailed)?;
    let staging = staging.ok_or(CacheError::AllocationFailed)?;
    let mut query = None;
    unsafe {
        device.CreateQuery(
            &D3D11_QUERY_DESC {
                Query: D3D11_QUERY_EVENT,
                MiscFlags: 0,
            },
            Some(&mut query),
        )
    }
    .map_err(|_| CacheError::AllocationFailed)?;
    let query = query.ok_or(CacheError::AllocationFailed)?;
    // copy_to holds the revocable source only for submission. The staging
    // resource is independent while waiting; privacy reset cancels this wait.
    source.copy_to(&staging)?;
    {
        let _guard = ContextGuard::enter(&context)?;
        unsafe {
            context.End(&query);
        }
    }
    let started = Instant::now();
    let mapped = loop {
        if !source.is_available() {
            return Err(CacheError::Expired);
        }
        if started.elapsed() > Duration::from_millis(500) {
            return Err(CacheError::ReadbackTimeout);
        }
        let guard = ContextGuard::enter(&context)?;
        let mut ready = 0u32;
        unsafe { context.GetData(&query, Some(std::ptr::addr_of_mut!(ready).cast()), 4, 0) }
            .map_err(|_| CacheError::DeviceLost)?;
        if ready != 0 {
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            match unsafe {
                context.Map(
                    &staging,
                    0,
                    D3D11_MAP_READ,
                    D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                    Some(&mut mapped),
                )
            } {
                Ok(()) => {
                    drop(guard);
                    break mapped;
                }
                Err(e)
                    if e.code() == windows::Win32::Graphics::Dxgi::DXGI_ERROR_WAS_STILL_DRAWING => {
                }
                Err(_) => return Err(CacheError::ReadbackFailed),
            }
        }
        drop(guard);
        std::thread::sleep(Duration::from_millis(2));
    };
    struct Mapping<'a>(&'a ID3D11DeviceContext, &'a ID3D11Texture2D);
    impl Drop for Mapping<'_> {
        fn drop(&mut self) {
            if let Ok(_guard) = ContextGuard::enter(self.0) {
                unsafe {
                    self.0.Unmap(self.1, 0);
                }
            }
        }
    }
    let mapping = Mapping(&context, &staging);
    let size = (mapped.RowPitch as usize)
        .checked_mul(height as usize)
        .filter(|n| *n <= isize::MAX as usize)
        .ok_or(CacheError::ReadbackFailed)?;
    if mapped.pData.is_null() {
        return Err(CacheError::ReadbackFailed);
    }
    let bytes = unsafe { std::slice::from_raw_parts(mapped.pData.cast::<u8>(), size) };
    // Existing tested BGRA -> RGBA row-pitch/orientation handling.
    let image = crate::platform::screen_capture::wgc::readback::unpack_bgra(
        bytes,
        width,
        height,
        mapped.RowPitch as usize,
    )
    .map_err(|_| CacheError::ReadbackFailed)?;
    drop(mapping);
    let result = PreviewImage {
        image,
        _permit: permit,
    };
    if !source.is_available() {
        return Err(CacheError::Expired);
    }
    Ok(result)
}
impl RecentGpuFrameCache {
    pub(crate) fn readback_for_preview(&self, lease: &FrameLease) -> Result<PreviewImage> {
        self.get(lease.metadata.id)?;
        let image = lease.readback()?;
        self.counters
            .manual_readbacks
            .fetch_add(1, Ordering::Relaxed);
        Ok(image)
    }
}
