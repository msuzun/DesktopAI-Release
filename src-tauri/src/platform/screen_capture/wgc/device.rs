use super::error::{CaptureError, CaptureResult, Result};
use windows::{
    core::Interface,
    Graphics::DirectX::Direct3D11::IDirect3DDevice,
    Win32::{
        Foundation::HMODULE,
        Graphics::{Direct3D::D3D_DRIVER_TYPE_HARDWARE, Direct3D11::*, Dxgi::IDXGIDevice},
        System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice,
    },
};

// Capture owns this context. Analysis shares it under ID3D11Multithread for brief
// command transactions, never while waiting for GPU completion. Resources use COM RAII.
pub struct Device {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub winrt: IDirect3DDevice,
}
impl Device {
    pub fn create() -> Result<Self> {
        let (mut device, mut context) = (None, None);
        // Valid out-parameters; no SINGLETHREADED flag: WGC uses the device internally.
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .capture("device_creation")?;
        let device = device.ok_or_else(|| CaptureError::new("device_creation"))?;
        let context = context.ok_or_else(|| CaptureError::new("device_creation"))?;
        // WGC also submits work internally. Protect the shared D3D immediate context
        // including the analyzer's explicit bind/dispatch critical section.
        let multithread: ID3D11Multithread = context.cast().capture("device_threading")?;
        unsafe {
            let _ = multithread.SetMultithreadProtected(true);
        }
        let dxgi: IDXGIDevice = device.cast().capture("device_conversion")?;
        let winrt = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
            .capture("device_conversion")?
            .cast()
            .capture("device_conversion")?;
        Ok(Self {
            device,
            context,
            winrt,
        })
    }
    pub fn texture(&self, desc: &D3D11_TEXTURE2D_DESC) -> Result<ID3D11Texture2D> {
        let mut texture = None;
        // Descriptor is initialized; COM owns the returned texture.
        unsafe { self.device.CreateTexture2D(desc, None, Some(&mut texture)) }
            .capture("texture_creation")?;
        texture.ok_or_else(|| CaptureError::new("texture_creation"))
    }
}
