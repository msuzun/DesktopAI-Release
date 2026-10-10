use super::{
    device::Device,
    error::{CaptureError, CaptureResult, Result},
    frame::{GpuFrameHandle, POOL_BUFFERS},
    Shared,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{Receiver, SyncSender},
    Arc,
};
use std::time::{Duration, Instant};
use windows::{
    core::{factory, IInspectable, Interface},
    Foundation::TypedEventHandler,
    Graphics::{Capture::*, DirectX::DirectXPixelFormat, SizeInt32},
    Win32::{
        Foundation::POINT,
        Graphics::{
            Direct3D11::*,
            Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY},
        },
        System::WinRT::{
            Direct3D11::IDirect3DDxgiInterfaceAccess,
            Graphics::Capture::IGraphicsCaptureItemInterop, RoInitialize, RoUninitialize,
            RO_INIT_MULTITHREADED,
        },
    },
};

pub enum Command {
    Preview(SyncSender<Result<image::RgbaImage>>),
}
struct Apartment;
impl Apartment {
    fn new() -> Result<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.capture("winrt_init")?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}
struct Capture {
    qpc_frequency: i64,
    device: Device,
    item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    arrived: Option<i64>,
    closed: Option<i64>,
    size: SizeInt32,
}
impl Drop for Capture {
    fn drop(&mut self) {
        if let Some(token) = self.arrived.take() {
            let _ = self.pool.RemoveFrameArrived(token);
        }
        if let Some(token) = self.closed.take() {
            let _ = self.item.RemoveClosed(token);
        }
        let _ = self.session.Close();
        let _ = self.pool.Close();
        unsafe {
            self.device.context.ClearState();
            self.device.context.Flush();
        }
    }
}
impl Capture {
    fn start(wake: SyncSender<()>, closed: Arc<AtomicBool>) -> Result<Self> {
        // CreateForMonitor requires Windows 10 1903 (18362); FreeThreaded requires 1809.
        if !GraphicsCaptureSession::IsSupported().capture("unsupported")? {
            return Err(CaptureError::new("unsupported"));
        }
        let interop: IGraphicsCaptureItemInterop =
            factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().capture("unsupported")?;
        // Primary display target is isolated here; no UI picker or monitor-selection policy.
        let monitor = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
        if monitor.0.is_null() {
            return Err(CaptureError::new("target_creation"));
        }
        let item: GraphicsCaptureItem =
            unsafe { interop.CreateForMonitor(monitor) }.capture("target_creation")?;
        let size = item.Size().capture("target_creation")?;
        if size.Width <= 0 || size.Height <= 0 {
            return Err(CaptureError::new("target_creation"));
        }
        let device = Device::create()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &device.winrt,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            POOL_BUFFERS,
            size,
        )
        .capture("frame_pool_creation")?;
        let session = match pool.CreateCaptureSession(&item) {
            Ok(session) => session,
            Err(e) => {
                let _ = pool.Close();
                return Err(CaptureError::windows("session_creation", e));
            }
        };
        let mut capture = Self {
            qpc_frequency: {
                let mut frequency = 0;
                unsafe {
                    windows::Win32::System::Performance::QueryPerformanceFrequency(&mut frequency)
                }
                .capture("frame_timestamp")?;
                frequency
            },
            device,
            item,
            pool,
            session,
            arrived: None,
            closed: None,
            size,
        };
        // Callback holds only a bounded wake sender, never the pool or producer: no COM/Arc cycle.
        capture.arrived = Some(
            capture
                .pool
                .FrameArrived(
                    &TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(
                        move |_, _| {
                            let _ = wake.try_send(());
                            Ok(())
                        },
                    ),
                )
                .capture("event_registration")?,
        );
        capture.closed = Some(
            capture
                .item
                .Closed(
                    &TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new(move |_, _| {
                        closed.store(true, Ordering::Release);
                        Ok(())
                    }),
                )
                .capture("event_registration")?,
        );
        capture.session.StartCapture().capture("session_start")?;
        Ok(capture)
    }
    fn acquire(&mut self, shared: &Shared, stop: &AtomicBool) -> Result<()> {
        let started = Instant::now();
        // At most POOL_BUFFERS checkouts per wake, never an unbounded drain loop.
        let mut newest = None;
        let mut received = 0;
        for _ in 0..POOL_BUFFERS {
            match self.pool.TryGetNextFrame() {
                Ok(frame) => {
                    if let Some(old) = newest.replace(frame) {
                        let _ = old.Close();
                    }
                    received += 1;
                }
                // A successful null WinRT return becomes Error::empty in windows-rs.
                Err(e)
                    if e.code() == windows::core::Error::empty().code()
                        || e.code() == windows::core::HRESULT(0x8000000Au32 as i32) =>
                {
                    break
                }
                Err(e) => {
                    if let Some(old) = newest.take() {
                        let _ = old.Close();
                    }
                    return Err(CaptureError::windows("frame_acquisition", e));
                }
            }
        }
        let Some(frame) = newest else {
            return Ok(());
        };
        // Close every checkout even when conversion/copy fails.
        struct Checkout(Direct3D11CaptureFrame);
        impl Drop for Checkout {
            fn drop(&mut self) {
                let _ = self.0.Close();
            }
        }
        let frame = Checkout(frame);
        let size = frame.0.ContentSize().capture("frame_acquisition")?;
        if size.Width <= 0 || size.Height <= 0 {
            return Ok(());
        }
        if size != self.size {
            drop(frame);
            {
                let mut s = shared.lock();
                s.latest = None;
                s.stats.frames_received += received;
                s.stats.frames_skipped += received;
                s.stats.pool_recreations += 1;
            }
            self.pool
                .Recreate(
                    &self.device.winrt,
                    DirectXPixelFormat::B8G8R8A8UIntNormalized,
                    POOL_BUFFERS,
                    size,
                )
                .capture("pool_recreation")?;
            self.size = size;
            return Ok(());
        }
        let surface = frame.0.Surface().capture("surface_conversion")?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast().capture("surface_conversion")?;
        let texture: ID3D11Texture2D =
            unsafe { access.GetInterface() }.capture("surface_conversion")?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            texture.GetDesc(&mut desc);
        }
        if desc.Width != size.Width as u32 || desc.Height != size.Height as u32 {
            return Err(CaptureError::new("texture_dimensions"));
        }
        if desc.Format != windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM {
            return Err(CaptureError::new("pixel_format"));
        }
        desc.Usage = D3D11_USAGE_DEFAULT;
        desc.CPUAccessFlags = 0;
        desc.MiscFlags = 0;
        desc.BindFlags = D3D11_BIND_SHADER_RESOURCE.0 as u32;
        let copy_started = Instant::now();
        let owned = self.device.texture(&desc)?;
        // Copy while checkout is alive. Owned texture survives frame.Close/pool reuse.
        unsafe {
            self.device.context.CopyResource(&owned, &texture);
            self.device.device.GetDeviceRemovedReason()
        }
        .capture("device_lost")?;
        let copy_ms = copy_started.elapsed().as_secs_f64() * 1000.; // CPU submission, NOT GPU completion time.
        let system_relative_100ns = frame
            .0
            .SystemRelativeTime()
            .capture("frame_timestamp")?
            .Duration;
        // WGC timestamps are compositor QPC time in 100ns units. Bridge to Instant
        // using a nearby QPC sample so freshness includes acquisition/copy delay.
        let mut qpc = 0;
        unsafe { windows::Win32::System::Performance::QueryPerformanceCounter(&mut qpc) }
            .capture("frame_timestamp")?;
        let now = Instant::now();
        let qpc_100ns = (qpc as i128 * 10_000_000 / self.qpc_frequency as i128) as i64;
        let age = Duration::from_nanos(
            qpc_100ns.saturating_sub(system_relative_100ns).max(0) as u64 * 100,
        );
        let captured_at = now
            .checked_sub(age)
            .ok_or_else(|| CaptureError::new("frame_timestamp"))?;
        let mut s = shared.lock();
        if stop.load(Ordering::Acquire) {
            return Ok(());
        }
        let id = s.stats.last_frame_id + 1;
        s.stats.frames_received += received;
        s.stats.frames_skipped += received - 1;
        s.stats.frames_replaced += u64::from(s.latest.is_some());
        s.stats.last_interval_ms = s
            .latest
            .as_ref()
            .map(|f| now.duration_since(f.received).as_secs_f64() * 1000.);
        s.stats.last_frame_id = id;
        s.stats.width = desc.Width;
        s.stats.height = desc.Height;
        s.stats.copy_submit_ms = copy_ms;
        s.stats.acquisition_ms = started.elapsed().as_secs_f64() * 1000.;
        s.latest = Some(Arc::new(GpuFrameHandle {
            capture_generation: s.stats.capture_generation,
            frame_id: id,
            captured_at,
            received: now,
            system_relative_100ns,
            width: desc.Width,
            height: desc.Height,
            pixel_format: desc.Format,
            texture: owned,
        }));
        Ok(())
    }
}
pub fn run(
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    wake_tx: SyncSender<()>,
    wake_rx: Receiver<()>,
    commands: Receiver<Command>,
    ready: SyncSender<Result<()>>,
) {
    let result = (|| -> Result<()> {
        let _apartment = Apartment::new()?;
        let closed = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        let mut capture = Capture::start(wake_tx, closed.clone())?;
        {
            let mut s = shared.lock();
            s.stats.state = "Running";
            s.stats.startup_ms = started.elapsed().as_secs_f64() * 1000.;
        }
        let _ = ready.send(Ok(()));
        let mut health_check = Instant::now();
        while !stop.load(Ordering::Acquire) {
            if health_check.elapsed() >= Duration::from_secs(1) {
                unsafe { capture.device.device.GetDeviceRemovedReason() }.capture("device_lost")?;
                health_check = Instant::now();
            }
            if closed.load(Ordering::Acquire) {
                return Err(CaptureError::new("target_closed"));
            }
            if let Ok(Command::Preview(reply)) = commands.try_recv() {
                let latest = shared.lock().latest.clone();
                let result = latest
                    .ok_or_else(|| CaptureError::new("no_frame"))
                    .and_then(|f| {
                        super::readback::readback_for_developer_preview(&capture.device, &f)
                    });
                if stop.load(Ordering::Acquire) {
                    let _ = reply.send(Err(CaptureError::new("stopped")));
                } else {
                    shared.lock().stats.readbacks += 1;
                    let _ = reply.send(result);
                }
            }
            // Timeout services control/device-health only; it does not pace or synthesize frames.
            if wake_rx.recv_timeout(Duration::from_millis(20)).is_ok() {
                capture.acquire(&shared, &stop)?;
            }
        }
        Ok(())
    })();
    let mut s = shared.lock();
    s.latest = None;
    match result {
        Ok(()) => s.stats.state = "Stopped",
        Err(error) => {
            s.stats.state = "Error";
            s.stats.capture_errors += 1;
            s.stats.error = Some(error.clone());
            let _ = ready.try_send(Err(error));
        }
    }
}
