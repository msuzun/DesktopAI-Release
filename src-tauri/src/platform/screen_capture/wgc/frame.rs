use std::time::Instant;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

// Not serializable. This texture is application-owned, not a checked-out WGC surface.
// Consumers may retain it, but must impose their own finite retention budget.
pub struct GpuFrameHandle {
    pub capture_generation: u64,
    pub frame_id: u64,
    pub captured_at: Instant,
    pub received: Instant,
    pub system_relative_100ns: i64,
    pub width: u32,
    pub height: u32,
    pub pixel_format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
    pub texture: ID3D11Texture2D,
}
impl crate::perception::SourceFrame for GpuFrameHandle {
    fn metadata(&self) -> crate::perception::FrameMetadata {
        crate::perception::FrameMetadata {
            capture_generation: self.capture_generation,
            frame_id: self.frame_id,
            source_timestamp: self.captured_at,
            width: self.width,
            height: self.height,
            pixel_format: PIXEL_FORMAT,
        }
    }
}
pub const PIXEL_FORMAT: &str = "BGRA8_UNORM";
// Two WGC buffers absorb a short producer delay; this is NOT temporal history.
pub const POOL_BUFFERS: i32 = 2;
