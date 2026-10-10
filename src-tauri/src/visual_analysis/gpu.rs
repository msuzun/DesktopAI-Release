use super::{AnalysisConfig, AnalysisError, Geometry, GpuTile, Result, MAX_TILES};
use crate::platform::screen_capture::wgc::frame::GpuFrameHandle;
use std::{mem::size_of, sync::OnceLock};
use windows::{
    core::{s, Interface},
    Win32::Graphics::{
        Direct3D::{Fxc::*, D3D_FEATURE_LEVEL_11_0},
        Direct3D11::*,
        Dxgi::Common::*,
    },
};

trait GpuResult<T> {
    fn stage(self, stage: &'static str) -> Result<T>;
}
impl<T> GpuResult<T> for windows::core::Result<T> {
    fn stage(self, stage: &'static str) -> Result<T> {
        self.map_err(|e| AnalysisError::windows(stage, e))
    }
}
fn required<T>(value: Option<T>, stage: &'static str) -> Result<T> {
    value.ok_or_else(|| AnalysisError::new(stage, "D3D11 returned an empty resource.", false))
}

// Explicitly holds the existing D3D multithread critical section for a short
// bind/dispatch transaction. Never held while sleeping, waiting, or classifying.
struct ContextGuard<'a>(&'a ID3D11Multithread);
impl Drop for ContextGuard<'_> {
    fn drop(&mut self) {
        unsafe {
            self.0.Leave();
        }
    }
}

fn compile(source: &[u8]) -> Result<Vec<u8>> {
    let (mut code, mut errors) = (None, None);
    unsafe {
        D3DCompile(
            source.as_ptr().cast(),
            source.len(),
            s!("embedded-analysis.hlsl"),
            None,
            None,
            s!("main"),
            s!("cs_5_0"),
            D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0,
            &mut code,
            Some(&mut errors),
        )
    }
    .stage("shader_compile")?;
    let code = required(code, "shader_compile")?;
    // Compiler owns this initialized bytecode blob for the duration of the copy.
    Ok(
        unsafe { std::slice::from_raw_parts(code.GetBufferPointer().cast(), code.GetBufferSize()) }
            .to_vec(),
    )
}
fn shaders(device: &ID3D11Device) -> Result<[ID3D11ComputeShader; 2]> {
    // Fixed embedded HLSL + flags, compiled by Windows D3DCompiler once per process.
    // No external compiler command, runtime source files, or per-frame compilation.
    static BYTECODE: OnceLock<Result<[Vec<u8>; 2]>> = OnceLock::new();
    let bytecode = BYTECODE
        .get_or_init(|| {
            Ok([
                compile(include_bytes!("shaders/luma.hlsl"))?,
                compile(include_bytes!("shaders/tiles.hlsl"))?,
            ])
        })
        .as_ref()
        .map_err(Clone::clone)?;
    let make = |code: &[u8]| {
        let mut shader = None;
        unsafe { device.CreateComputeShader(code, None, Some(&mut shader)) }
            .stage("compute_shader")?;
        required(shader, "compute_shader")
    };
    Ok([make(&bytecode[0])?, make(&bytecode[1])?])
}

struct Image {
    texture: ID3D11Texture2D,
    srv: ID3D11ShaderResourceView,
    uav: Option<ID3D11UnorderedAccessView>,
}
fn image(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
    writable: bool,
) -> Result<Image> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_SHADER_RESOURCE.0
            | if writable {
                D3D11_BIND_UNORDERED_ACCESS.0
            } else {
                0
            }) as u32,
        ..Default::default()
    };
    let (mut texture, mut srv, mut uav) = (None, None, None);
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }.stage("analysis_texture")?;
    let texture = required(texture, "analysis_texture")?;
    unsafe { device.CreateShaderResourceView(&texture, None, Some(&mut srv)) }
        .stage("analysis_srv")?;
    if writable {
        unsafe { device.CreateUnorderedAccessView(&texture, None, Some(&mut uav)) }
            .stage("analysis_uav")?;
    }
    Ok(Image {
        texture,
        srv: required(srv, "analysis_srv")?,
        uav,
    })
}
fn buffer(device: &ID3D11Device, desc: D3D11_BUFFER_DESC) -> Result<ID3D11Buffer> {
    let mut buffer = None;
    unsafe { device.CreateBuffer(&desc, None, Some(&mut buffer)) }.stage("analysis_buffer")?;
    required(buffer, "analysis_buffer")
}

struct Resources {
    geometry: Geometry,
    input: Image,
    luma: [Image; 2],
    tiles: ID3D11Buffer,
    tiles_uav: ID3D11UnorderedAccessView,
    staging: ID3D11Buffer,
    luma_staging: ID3D11Texture2D,
    half_luma: Vec<u16>,
    cpu_luma: Vec<u8>,
    mapped_luma_bytes: usize,
    current: usize,
}
impl Resources {
    fn new(device: &ID3D11Device, geometry: Geometry) -> Result<Self> {
        // WGC publishes a new immutable texture each time. Reuse one input/SRV
        // instead of allocating a new SRV per frame. This adds one GPU-only copy
        // per accepted frame; it is the only full-size analysis resource.
        let input = image(
            device,
            geometry.source_width,
            geometry.source_height,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            false,
        )?;
        // R16_FLOAT keeps sub-byte luma precision at half the R32 storage. We only
        // store through UAVs and load through SRVs (no typed-UAV load dependency).
        let luma = [
            image(
                device,
                geometry.analysis_width,
                geometry.analysis_height,
                DXGI_FORMAT_R16_FLOAT,
                true,
            )?,
            image(
                device,
                geometry.analysis_width,
                geometry.analysis_height,
                DXGI_FORMAT_R16_FLOAT,
                true,
            )?,
        ];
        let bytes = (geometry.tile_count() * size_of::<GpuTile>()) as u32;
        let mut luma_staging = None;
        unsafe {
            device.CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Width: geometry.analysis_width,
                    Height: geometry.analysis_height,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_R16_FLOAT,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_STAGING,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    ..Default::default()
                },
                None,
                Some(&mut luma_staging),
            )
        }
        .stage("temporal_luma_staging")?;
        let pixels = geometry.analysis_width as usize * geometry.analysis_height as usize;
        let tiles = buffer(
            device,
            D3D11_BUFFER_DESC {
                ByteWidth: bytes,
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_UNORDERED_ACCESS.0 as u32,
                MiscFlags: D3D11_RESOURCE_MISC_BUFFER_STRUCTURED.0 as u32,
                StructureByteStride: size_of::<GpuTile>() as u32,
                ..Default::default()
            },
        )?;
        let mut uav = None;
        unsafe { device.CreateUnorderedAccessView(&tiles, None, Some(&mut uav)) }
            .stage("tile_uav")?;
        let staging = buffer(
            device,
            D3D11_BUFFER_DESC {
                ByteWidth: bytes,
                Usage: D3D11_USAGE_STAGING,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                ..Default::default()
            },
        )?;
        Ok(Self {
            geometry,
            input,
            luma,
            tiles,
            tiles_uav: required(uav, "tile_uav")?,
            staging,
            luma_staging: required(luma_staging, "temporal_luma_staging")?,
            half_luma: vec![0; pixels],
            cpu_luma: vec![0; pixels],
            mapped_luma_bytes: 0,
            current: 0,
        })
    }
}

#[repr(C)]
struct Constants {
    source: [u32; 2],
    analysis: [u32; 2],
    grid: [u32; 2],
    noise: f32,
    baseline: u32,
}

pub struct GpuAnalyzer {
    config: AnalysisConfig,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    multithread: ID3D11Multithread,
    shaders: [ID3D11ComputeShader; 2],
    sampler: ID3D11SamplerState,
    constants: ID3D11Buffer,
    completion: ID3D11Query,
    resources: Resources,
    in_flight: bool,
    pub resource_sets: u64,
}
impl GpuAnalyzer {
    pub fn new(frame: &GpuFrameHandle, config: AnalysisConfig) -> Result<Self> {
        let device = unsafe { frame.texture.GetDevice() }.stage("source_device")?;
        if unsafe { device.GetFeatureLevel() }.0 < D3D_FEATURE_LEVEL_11_0.0 {
            return Err(AnalysisError::new(
                "feature_level",
                "GPU analysis requires Direct3D feature level 11.0.",
                false,
            ));
        }
        let support =
            unsafe { device.CheckFormatSupport(DXGI_FORMAT_R16_FLOAT) }.stage("luma_format")?;
        let required_support = (D3D11_FORMAT_SUPPORT_SHADER_LOAD.0
            | D3D11_FORMAT_SUPPORT_TYPED_UNORDERED_ACCESS_VIEW.0)
            as u32;
        if support & required_support != required_support {
            return Err(AnalysisError::new(
                "luma_format",
                "R16_FLOAT GPU analysis is unsupported on this device.",
                false,
            ));
        }
        let context = unsafe { device.GetImmediateContext() }.stage("immediate_context")?;
        let multithread: ID3D11Multithread = context.cast().stage("context_threading")?;
        // WGC enables this at device creation. Tests and any future source must too.
        if !unsafe { multithread.GetMultithreadProtected() }.as_bool() {
            return Err(AnalysisError::new(
                "context_threading",
                "Capture context must enable multithread protection.",
                false,
            ));
        }
        let geometry = Geometry::new(frame.width, frame.height, config)?;
        Self::validate_source(&device, frame)?;
        let shaders = shaders(&device)?;
        let mut sampler = None;
        unsafe {
            device.CreateSamplerState(
                &D3D11_SAMPLER_DESC {
                    Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
                    AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                    ComparisonFunc: D3D11_COMPARISON_NEVER,
                    MaxLOD: f32::MAX,
                    ..Default::default()
                },
                Some(&mut sampler),
            )
        }
        .stage("analysis_sampler")?;
        let constants = buffer(
            &device,
            D3D11_BUFFER_DESC {
                ByteWidth: size_of::<Constants>() as u32,
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                ..Default::default()
            },
        )?;
        let mut completion = None;
        unsafe {
            device.CreateQuery(
                &D3D11_QUERY_DESC {
                    Query: D3D11_QUERY_EVENT,
                    MiscFlags: 0,
                },
                Some(&mut completion),
            )
        }
        .stage("completion_query")?;
        let resources = Resources::new(&device, geometry)?;
        Ok(Self {
            config,
            device,
            context,
            multithread,
            shaders,
            sampler: required(sampler, "analysis_sampler")?,
            constants,
            completion: required(completion, "completion_query")?,
            resources,
            in_flight: false,
            resource_sets: 1,
        })
    }
    fn enter(&self) -> ContextGuard<'_> {
        unsafe {
            self.multithread.Enter();
        }
        ContextGuard(&self.multithread)
    }
    pub fn same_device(&self, frame: &GpuFrameHandle) -> Result<bool> {
        Ok(unsafe { frame.texture.GetDevice() }.stage("source_device")? == self.device)
    }
    fn validate_source(device: &ID3D11Device, frame: &GpuFrameHandle) -> Result<()> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            frame.texture.GetDesc(&mut desc);
        }
        if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
            || frame.pixel_format != desc.Format
            || desc.Width != frame.width
            || desc.Height != frame.height
            || desc.ArraySize != 1
            || desc.MipLevels != 1
            || desc.SampleDesc.Count != 1
            || desc.SampleDesc.Quality != 0
            || unsafe { frame.texture.GetDevice() }.stage("source_device")? != *device
        {
            return Err(AnalysisError::new("source_layout", "Expected same-device, single-sample, single-mip BGRA8 texture with matching dimensions.", true));
        }
        // Source bind flags need not include SRV: the reusable GPU copy has that
        // binding. No CPU access/upload conversion is used for unsupported inputs.
        Ok(())
    }
    pub fn prepare(&mut self, frame: &GpuFrameHandle, config: AnalysisConfig) -> Result<bool> {
        Self::validate_source(&self.device, frame)?;
        let geometry = Geometry::new(frame.width, frame.height, config)?;
        let configuration_changed = config != self.config;
        if geometry != self.resources.geometry {
            self.resources = Resources::new(&self.device, geometry)?;
            self.resource_sets += 1;
            self.config = config;
            return Ok(true);
        }
        self.config = config;
        // Threshold-only changes need a baseline reset, not new textures/shaders.
        Ok(configuration_changed)
    }
    pub fn geometry(&self) -> Geometry {
        self.resources.geometry
    }
    pub fn submit(
        &mut self,
        frame: &GpuFrameHandle,
        config: AnalysisConfig,
        baseline: bool,
    ) -> Result<()> {
        if self.in_flight {
            return Err(AnalysisError::new(
                "analysis_busy",
                "Only one GPU analysis may be in flight.",
                false,
            ));
        }
        let r = &self.resources;
        let g = r.geometry;
        let constants = Constants {
            source: [g.source_width, g.source_height],
            analysis: [g.analysis_width, g.analysis_height],
            grid: [g.tile_columns, g.tile_rows],
            noise: config.pixel_noise_threshold,
            baseline: u32::from(baseline),
        };
        {
            let _guard = self.enter();
            unsafe {
                self.context.CopyResource(&r.input.texture, &frame.texture);
                self.context.UpdateSubresource(
                    &self.constants,
                    0,
                    None,
                    std::ptr::addr_of!(constants).cast(),
                    0,
                    0,
                );
                self.context
                    .CSSetConstantBuffers(0, Some(&[Some(self.constants.clone())]));
                self.context
                    .CSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
                self.context.CSSetShader(&self.shaders[0], None);
                self.context
                    .CSSetShaderResources(0, Some(&[Some(r.input.srv.clone())]));
                self.context.CSSetUnorderedAccessViews(
                    0,
                    1,
                    Some([r.luma[r.current].uav.clone()].as_ptr()),
                    None,
                );
                self.context.Dispatch(
                    g.analysis_width.div_ceil(8),
                    g.analysis_height.div_ceil(8),
                    1,
                );
                self.context
                    .CSSetUnorderedAccessViews(0, 1, Some([None].as_ptr()), None);
                self.context.CSSetShaderResources(
                    0,
                    Some(&[
                        Some(r.luma[r.current].srv.clone()),
                        Some(r.luma[1 - r.current].srv.clone()),
                    ]),
                );
                self.context.CSSetShader(&self.shaders[1], None);
                self.context.CSSetUnorderedAccessViews(
                    0,
                    1,
                    Some([Some(r.tiles_uav.clone())].as_ptr()),
                    None,
                );
                self.context.Dispatch(g.tile_columns, g.tile_rows, 1);
                self.context
                    .CSSetUnorderedAccessViews(0, 1, Some([None].as_ptr()), None);
                self.context.CSSetShaderResources(0, Some(&[None, None]));
                self.context.CSSetShader(None, None);
                self.context.CSSetSamplers(0, Some(&[None]));
                self.context.CSSetConstantBuffers(0, Some(&[None]));
                self.context.CopyResource(&r.staging, &r.tiles);
                // The same EVENT covers both compact metrics and downsampled
                // luma. Never copy the full-resolution source to CPU staging.
                self.context
                    .CopyResource(&r.luma_staging, &r.luma[r.current].texture);
                self.context.End(&self.completion);
                self.device
                    .GetDeviceRemovedReason()
                    .stage("dispatch_device_lost")?;
            }
        }
        self.in_flight = true;
        Ok(())
    }
    pub fn poll(&mut self) -> Result<Option<[GpuTile; MAX_TILES]>> {
        let mut ready = 0u32;
        let multithread = self.multithread.clone();
        unsafe {
            multithread.Enter();
        }
        let guard = ContextGuard(&multithread);
        // GetData with default flags lets the runtime submit pending commands.
        // No explicit Flush, blocking Map, or query spin loop. EVENT data stays
        // false on S_FALSE (windows-rs maps both success HRESULTs to Ok).
        unsafe {
            self.context.GetData(
                &self.completion,
                Some(std::ptr::addr_of_mut!(ready).cast()),
                size_of::<u32>() as u32,
                0,
            )
        }
        .stage("completion_query")?;
        if ready == 0 {
            return Ok(None);
        }
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        match unsafe {
            self.context.Map(
                &self.resources.staging,
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(&mut mapped),
            )
        } {
            Err(e) if e.code() == windows::Win32::Graphics::Dxgi::DXGI_ERROR_WAS_STILL_DRAWING => {
                return Ok(None)
            }
            other => other.stage("compact_readback_map")?,
        }
        let mut tiles = [GpuTile::default(); MAX_TILES];
        let result = if mapped.pData.is_null() {
            Err(AnalysisError::new(
                "compact_readback_map",
                "Mapped metadata pointer was null.",
                false,
            ))
        } else {
            // Exactly the initialized compact staging ByteWidth; no pixels or
            // mapped references escape Unmap. Unaligned reads are safe here.
            for (i, tile) in tiles[..self.resources.geometry.tile_count()]
                .iter_mut()
                .enumerate()
            {
                *tile = unsafe { mapped.pData.cast::<GpuTile>().add(i).read_unaligned() };
            }
            Ok(Some(tiles))
        };
        unsafe {
            self.context.Unmap(&self.resources.staging, 0);
        }
        let result = result?;
        let r = &mut self.resources;
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        match unsafe {
            self.context.Map(
                &r.luma_staging,
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(&mut mapped),
            )
        } {
            Err(e) if e.code() == windows::Win32::Graphics::Dxgi::DXGI_ERROR_WAS_STILL_DRAWING => {
                return Ok(None)
            }
            other => other.stage("temporal_luma_map")?,
        }
        let width = r.geometry.analysis_width as usize;
        let height = r.geometry.analysis_height as usize;
        let valid = !mapped.pData.is_null() && mapped.RowPitch as usize >= width * 2;
        if valid {
            for y in 0..height {
                // Honor driver row pitch; packed CPU scratch has no padding.
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        mapped.pData.cast::<u8>().add(y * mapped.RowPitch as usize),
                        r.half_luma.as_mut_ptr().cast::<u8>().add(y * width * 2),
                        width * 2,
                    );
                }
            }
            r.mapped_luma_bytes = mapped.RowPitch as usize * height;
        }
        unsafe {
            self.context.Unmap(&r.luma_staging, 0);
        }
        drop(guard);
        if !valid {
            return Err(AnalysisError::new(
                "temporal_luma_map",
                "Invalid low-resolution luma layout.",
                false,
            ));
        }
        // Quantize the existing analysis representation, after releasing D3D.
        // Luma is nonnegative finite [0,1]; half subnormals all round to byte 0.
        for (out, &half) in r.cpu_luma.iter_mut().zip(&r.half_luma) {
            *out = luma_byte(half);
        }
        Ok(result)
    }
    pub fn luma(&self) -> &[u8] {
        &self.resources.cpu_luma
    }
    pub fn luma_staging_bytes(&self) -> usize {
        self.resources.mapped_luma_bytes
    }
    pub fn luma_scratch_bytes(&self) -> usize {
        self.resources.half_luma.capacity() * 2 + self.resources.cpu_luma.capacity()
    }
    pub fn finish(&mut self, success: bool) {
        // Failed result processing overwrites the same current texture next time,
        // preserving the last successfully committed previous luma resource.
        if success {
            self.resources.current = 1 - self.resources.current;
        }
        self.in_flight = false;
    }
}

fn luma_byte(half: u16) -> u8 {
    if half & 0x8000 != 0 || half & 0x7c00 == 0 {
        return 0;
    }
    let value = f32::from_bits(((half as u32 & 0x7fff) << 13) + (112 << 23));
    (value.clamp(0., 1.) * 255.).round() as u8
}
impl Drop for Resources {
    fn drop(&mut self) {
        self.half_luma.fill(0);
        self.cpu_luma.fill(0);
    }
}
