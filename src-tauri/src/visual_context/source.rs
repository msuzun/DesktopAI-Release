use super::model::*;
use crate::visual_events::{KeyframeId, StateSignal, TurnState};
use image::RgbaImage;
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor(pub u64, pub u64);
pub type Generation = [u64; 3];
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Lineage {
    pub capture_generation: u64,
    pub source_frame_id: u64,
    pub perception_sequence: u64,
    pub analysis_sequence: u64,
}
#[derive(Clone)]
pub struct SourceInfo {
    pub cursor: Cursor,
    pub timestamp: Instant,
    pub width: u32,
    pub height: u32,
    pub role: Role,
    pub correlation: &'static str,
    pub delta_ms: f64,
    pub lineage: Option<Lineage>,
}
pub struct Pixels(pub RgbaImage);
impl Drop for Pixels {
    fn drop(&mut self) {
        self.0.as_mut().fill(0);
    }
}
pub trait Asset: Send + Sync {
    fn info(&self) -> SourceInfo;
    fn available(&self) -> bool;
    fn read(&self) -> Result<Pixels>;
    fn snapshot(&self) -> Result<Arc<dyn Asset>>;
    fn reserve(&self, _: Instant) -> Option<Arc<dyn Asset>> {
        None
    }
    fn current_snapshot(&self) -> Result<Arc<dyn Asset>> {
        Ok(Arc::new(CurrentAsset(self.snapshot()?)))
    }
    fn revoke(&self) {}
    fn owned_bytes(&self) -> u64 {
        0
    }
}
// Role belongs to this turn's immutable snapshot, not the history cache entry.
struct CurrentAsset(Arc<dyn Asset>);
impl Asset for CurrentAsset {
    fn info(&self) -> SourceInfo {
        let mut info = self.0.info();
        info.role = Role::Current;
        info
    }
    fn available(&self) -> bool {
        self.0.available()
    }
    fn read(&self) -> Result<Pixels> {
        self.0.read()
    }
    fn snapshot(&self) -> Result<Arc<dyn Asset>> {
        Err(error("invalid_arguments"))
    }
    fn revoke(&self) {
        self.0.revoke();
    }
    fn owned_bytes(&self) -> u64 {
        self.0.owned_bytes()
    }
}
#[derive(Clone)]
pub struct Candidate {
    pub identity: Cursor,
    pub scene: u64,
    pub start: Instant,
    pub peak: Instant,
    pub end: Option<Instant>,
    pub description: &'static str,
    pub confidence: f64,
    pub region: Option<Region>,
    pub rank: u8,
    pub asset: Option<Arc<dyn Asset>>,
}
#[derive(Clone)]
pub struct History {
    pub events: Vec<Candidate>,
    pub coverage_ms: f64,
}
pub trait Sources: Send + Sync {
    fn generation(&self) -> Generation;
    fn latest(&self) -> Result<Option<Arc<dyn Asset>>>;
    // One request-driven capture when a quiet compositor supplies no fresh
    // frame. Never used to reconstruct an unavailable historical moment.
    fn capture_current(&self) -> Result<Option<Arc<dyn Asset>>> {
        Ok(None)
    }
    fn newer(&self, after: Option<Cursor>, deadline: Instant) -> Result<Option<Arc<dyn Asset>>>;
    fn history(&self, start: Instant, reference: Instant) -> Result<History>;
    fn turn_state(&self, _: Instant) -> TurnState {
        TurnState::default()
    }
    fn signal(&self) -> Option<Arc<StateSignal>> {
        None
    }
    fn near(&self, _: Instant, _: Instant, _: Instant) -> Result<Option<Arc<dyn Asset>>> {
        Ok(None)
    }
    fn keyframe(&self, _: KeyframeId) -> Option<Arc<dyn Asset>> {
        None
    }
    fn compatibility(&self) -> bool {
        false
    }
}

// Legacy compatibility owns at most one turn-scoped, revocable CPU source.
// WGC and historical sources never use this representation.
#[derive(Clone)]
pub struct CpuAsset {
    info: SourceInfo,
    image: Arc<Mutex<Option<Pixels>>>,
}
impl CpuAsset {
    pub fn new(image: RgbaImage, timestamp: Instant, cursor: Cursor) -> Self {
        let (width, height) = image.dimensions();
        Self {
            info: SourceInfo {
                cursor,
                timestamp,
                width,
                height,
                role: Role::Current,
                correlation: "Exact",
                delta_ms: 0.,
                lineage: None,
            },
            image: Arc::new(Mutex::new(Some(Pixels(image)))),
        }
    }
}
impl Asset for CpuAsset {
    fn info(&self) -> SourceInfo {
        self.info.clone()
    }
    fn available(&self) -> bool {
        self.image
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }
    fn read(&self) -> Result<Pixels> {
        self.image
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|p| Pixels(p.0.clone()))
            .ok_or_else(|| error("snapshot_expired"))
    }
    fn snapshot(&self) -> Result<Arc<dyn Asset>> {
        Ok(Arc::new(self.clone()))
    }
    fn revoke(&self) {
        self.image.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
    fn owned_bytes(&self) -> u64 {
        self.info.width as u64 * self.info.height as u64 * 4
    }
}

pub struct LegacySources;
impl Sources for LegacySources {
    fn generation(&self) -> Generation {
        [0; 3]
    }
    fn compatibility(&self) -> bool {
        true
    }
    fn latest(&self) -> Result<Option<Arc<dyn Asset>>> {
        use crate::platform::screen_capture::{NativeScreenCapture, ScreenCaptureService};
        let image = NativeScreenCapture.capture_primary_screen()?;
        let timestamp = Instant::now();
        if image.width() as u64 * image.height() as u64 * 4 > SNAPSHOT_GPU_BUDGET {
            return Err(error("current_unavailable"));
        }
        Ok(Some(Arc::new(CpuAsset::new(
            image,
            timestamp,
            Cursor(0, 0),
        ))))
    }
    fn newer(&self, _: Option<Cursor>, _: Instant) -> Result<Option<Arc<dyn Asset>>> {
        Ok(None)
    }
    fn history(&self, _: Instant, _: Instant) -> Result<History> {
        Err(error("history_unavailable"))
    }
}

#[cfg(windows)]
pub mod gpu {
    use super::*;
    use crate::{
        promoted_keyframes::{Metadata, PromotedKeyframeCache},
        recent_gpu_cache::{
            self,
            gpu::{PreviewImage, PreviewSource},
            FrameId, FrameLease,
        },
        temporal_memory::TemporalMemory,
        visual_events::{EventMemory, EventType},
    };
    use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};
    fn lineage(m: recent_gpu_cache::Metadata) -> Lineage {
        Lineage {
            capture_generation: m.capture_generation,
            source_frame_id: m.source_frame_id,
            perception_sequence: m.perception_sequence,
            analysis_sequence: m.analysis_sequence,
        }
    }
    fn pixels(mut preview: PreviewImage) -> Pixels {
        Pixels(std::mem::replace(&mut preview.image, RgbaImage::new(0, 0)))
    }
    pub struct NativeSources {
        pub recent: recent_gpu_cache::RecentGpuFrameCache,
        pub history: TemporalMemory,
        pub events: EventMemory,
    }
    impl Sources for NativeSources {
        fn capture_current(&self) -> Result<Option<Arc<dyn Asset>>> {
            // Hold an immutable bitmap now; defer CPU readback/conversion until
            // confirmed speech. No display, memory-tier or timestamp substitution.
            let bitmap =
                crate::platform::screen_capture::CapturedBitmap::primary(SNAPSHOT_GPU_BUDGET)?;
            Ok(Some(Arc::new(FrozenDesktop {
                info: SourceInfo {
                    cursor: Cursor(0, 0),
                    timestamp: bitmap.captured_at,
                    width: bitmap.width,
                    height: bitmap.height,
                    role: Role::Current,
                    correlation: "Exact",
                    delta_ms: 0.,
                    lineage: None,
                },
                bitmap: Arc::new(Mutex::new(Some(bitmap))),
            })))
        }
        fn turn_state(&self, reference: Instant) -> TurnState {
            self.events.turn_state(reference)
        }
        fn signal(&self) -> Option<Arc<StateSignal>> {
            Some(self.events.signal())
        }
        fn near(
            &self,
            reference: Instant,
            start: Instant,
            end: Instant,
        ) -> Result<Option<Arc<dyn Asset>>> {
            // Tier B has only a handful of metadata entries. Filter before nearest
            // lookup so a post-turn scene can never win a temporal tie.
            let candidate = self
                .recent
                .recent_entries()
                .into_iter()
                .filter(|m| m.source_timestamp >= start && m.source_timestamp <= end)
                .min_by_key(|m| {
                    (
                        if m.source_timestamp >= reference {
                            m.source_timestamp - reference
                        } else {
                            reference - m.source_timestamp
                        },
                        std::cmp::Reverse(m.source_timestamp),
                    )
                });
            Ok(candidate
                .and_then(|m| self.recent.get(m.id).ok())
                .map(|lease| Arc::new(Immediate(lease)) as Arc<dyn Asset>))
        }
        fn keyframe(&self, id: KeyframeId) -> Option<Arc<dyn Asset>> {
            let cache = self.events.keyframes();
            let metadata = cache.keyframe(id, Instant::now())?.metadata();
            Some(Arc::new(Historical { cache, metadata }))
        }
        fn generation(&self) -> Generation {
            [
                self.recent.generation(),
                self.history.generation(),
                self.events.generation(),
            ]
        }
        fn latest(&self) -> Result<Option<Arc<dyn Asset>>> {
            Ok(self
                .recent
                .latest()
                .map(|lease| Arc::new(Immediate(lease)) as Arc<dyn Asset>))
        }
        fn newer(
            &self,
            after: Option<Cursor>,
            deadline: Instant,
        ) -> Result<Option<Arc<dyn Asset>>> {
            Ok(self
                .recent
                .wait_for_newer(
                    after.map(|c| FrameId {
                        cache_generation: c.0,
                        cache_sequence: c.1,
                    }),
                    deadline,
                )
                .map(|lease| Arc::new(Immediate(lease)) as Arc<dyn Asset>))
        }
        fn history(&self, start: Instant, reference: Instant) -> Result<History> {
            let now = Instant::now();
            let samples = self.history.samples_between(start, reference, now);
            let coverage_ms = samples.first().zip(samples.last()).map_or(0., |(a, b)| {
                millis(
                    b.source_timestamp
                        .saturating_duration_since(a.source_timestamp),
                )
            });
            let events = self.events.events_between(start, reference, now);
            let cache = self.events.keyframes();
            let mut result = Vec::with_capacity(events.len());
            for e in events {
                let asset = e
                    .keyframe
                    .and_then(|id| cache.keyframe(id, now))
                    .map(|lease| {
                        Arc::new(Historical {
                            cache: cache.clone(),
                            metadata: lease.metadata(),
                        }) as Arc<dyn Asset>
                    });
                let (description, rank) = match e.kind {
                    EventType::LocalizedTransient => ("short-lived localized visual change", 0),
                    EventType::SceneTransition => ("large visual transition", 2),
                    EventType::StableSceneEstablished => ("stable visual state established", 1),
                    EventType::LocalizedPersistentChange => {
                        ("persistent localized visual change", 3)
                    }
                    EventType::ReturnToStableState => ("return to a stable visual state", 4),
                };
                result.push(Candidate {
                    identity: Cursor(e.id.generation, e.id.sequence),
                    scene: e.scene_sequence,
                    start: e.start.timestamp,
                    peak: e.peak.timestamp,
                    end: e.end.map(|m| m.timestamp),
                    description,
                    confidence: e.detection_confidence,
                    region: e.bounds.map(|b| Region {
                        x: b.x,
                        y: b.y,
                        width: b.width,
                        height: b.height,
                    }),
                    rank,
                    asset,
                });
            }
            Ok(History {
                events: result,
                coverage_ms,
            })
        }
    }
    #[derive(Clone)]
    struct FrozenDesktop {
        info: SourceInfo,
        bitmap: Arc<Mutex<Option<crate::platform::screen_capture::CapturedBitmap>>>,
    }
    impl Asset for FrozenDesktop {
        fn info(&self) -> SourceInfo {
            self.info.clone()
        }
        fn available(&self) -> bool {
            self.bitmap
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some()
        }
        fn read(&self) -> Result<Pixels> {
            self.bitmap
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_mut()
                .ok_or_else(|| error("snapshot_expired"))?
                .read()
                .map(Pixels)
        }
        fn snapshot(&self) -> Result<Arc<dyn Asset>> {
            Ok(Arc::new(self.clone()))
        }
        fn revoke(&self) {
            self.bitmap.lock().unwrap_or_else(|e| e.into_inner()).take();
        }
        fn owned_bytes(&self) -> u64 {
            self.info.width as u64 * self.info.height as u64 * 4
        }
    }
    struct Immediate(FrameLease);
    impl Asset for Immediate {
        fn info(&self) -> SourceInfo {
            let m = self.0.metadata();
            SourceInfo {
                cursor: Cursor(m.id.cache_generation, m.id.cache_sequence),
                timestamp: m.source_timestamp,
                width: m.width,
                height: m.height,
                role: Role::Current,
                correlation: "Exact",
                delta_ms: 0.,
                lineage: Some(lineage(m)),
            }
        }
        fn available(&self) -> bool {
            self.0.is_available()
        }
        fn read(&self) -> Result<Pixels> {
            self.0
                .readback()
                .map(pixels)
                .map_err(|_| error("readback_failed"))
        }
        fn snapshot(&self) -> Result<Arc<dyn Asset>> {
            copy_snapshot(&self.0, self.info())
        }
    }
    fn copy_snapshot(source: &impl PreviewSource, info: SourceInfo) -> Result<Arc<dyn Asset>> {
        if info.width as u64 * info.height as u64 * 4 > SNAPSHOT_GPU_BUDGET {
            return Err(error("current_unavailable"));
        }
        let device = source.device().map_err(|_| error("readback_failed"))?;
        let mut texture = None;
        unsafe {
            device.CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Width: info.width,
                    Height: info.height,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                    ..Default::default()
                },
                None,
                Some(&mut texture),
            )
        }
        .map_err(|_| error("readback_failed"))?;
        let texture = texture.ok_or_else(|| error("readback_failed"))?;
        source
            .copy_to(&texture)
            .map_err(|_| error("readback_failed"))?;
        Ok(Arc::new(Owned {
            info,
            texture: Mutex::new(Some(texture)),
        }))
    }
    struct Owned {
        info: SourceInfo,
        texture: Mutex<Option<ID3D11Texture2D>>,
    }
    impl PreviewSource for Owned {
        fn dimensions(&self) -> (u32, u32) {
            (self.info.width, self.info.height)
        }
        fn is_available(&self) -> bool {
            self.available()
        }
        fn device(&self) -> recent_gpu_cache::Result<ID3D11Device> {
            let t = self.texture.lock().unwrap_or_else(|e| e.into_inner());
            unsafe {
                t.as_ref()
                    .ok_or(recent_gpu_cache::CacheError::Expired)?
                    .GetDevice()
            }
            .map_err(|_| recent_gpu_cache::CacheError::DeviceLost)
        }
        fn copy_to(&self, destination: &ID3D11Texture2D) -> recent_gpu_cache::Result<()> {
            let t = self.texture.lock().unwrap_or_else(|e| e.into_inner());
            recent_gpu_cache::gpu::copy_texture(
                t.as_ref().ok_or(recent_gpu_cache::CacheError::Expired)?,
                destination,
            )
        }
    }
    impl Asset for Owned {
        fn info(&self) -> SourceInfo {
            self.info.clone()
        }
        fn available(&self) -> bool {
            self.texture
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some()
        }
        fn read(&self) -> Result<Pixels> {
            recent_gpu_cache::gpu::readback(self)
                .map(pixels)
                .map_err(|_| error("readback_failed"))
        }
        fn snapshot(&self) -> Result<Arc<dyn Asset>> {
            Err(error("invalid_arguments"))
        }
        fn revoke(&self) {
            self.texture
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
        }
        fn owned_bytes(&self) -> u64 {
            self.info.width as u64 * self.info.height as u64 * 4
        }
    }
    #[derive(Clone)]
    struct Historical {
        cache: PromotedKeyframeCache,
        metadata: Metadata,
    }
    impl Asset for Historical {
        fn reserve(&self, until: Instant) -> Option<Arc<dyn Asset>> {
            Some(Arc::new(ReservedHistorical {
                lease: self.cache.reserve_for_turn(self.metadata.id, until)?,
                info: self.info(),
            }))
        }
        fn current_snapshot(&self) -> Result<Arc<dyn Asset>> {
            // Provisional slots may be replaced; copy only the selected moment
            // into the existing one-Current M7.7 ownership budget.
            let lease = self
                .cache
                .keyframe(self.metadata.id, Instant::now())
                .ok_or_else(|| error("snapshot_expired"))?;
            let mut info = self.info();
            info.role = Role::Current;
            copy_snapshot(&lease, info)
        }
        fn info(&self) -> SourceInfo {
            let m = self.metadata;
            SourceInfo {
                cursor: Cursor(m.id.generation, m.id.sequence),
                timestamp: m.source.source_timestamp,
                width: m.source.width,
                height: m.source.height,
                role: if m.kind == crate::visual_events::KeyframeType::Transient {
                    Role::RecentTransient
                } else {
                    Role::RecentStable
                },
                correlation: match m.correlation {
                    recent_gpu_cache::MatchKind::ExactSource => "Exact",
                    recent_gpu_cache::MatchKind::ExactPerception => "Exact observation",
                    recent_gpu_cache::MatchKind::NearestTimestamp => "Nearest timestamp",
                },
                delta_ms: millis(m.correlation_delta),
                lineage: Some(lineage(m.source)),
            }
        }
        fn available(&self) -> bool {
            self.cache
                .keyframe(self.metadata.id, Instant::now())
                .is_some()
        }
        fn read(&self) -> Result<Pixels> {
            self.cache
                .keyframe(self.metadata.id, Instant::now())
                .ok_or_else(|| error("snapshot_expired"))?
                .readback()
                .map(pixels)
                .map_err(|_| error("readback_failed"))
        }
        fn snapshot(&self) -> Result<Arc<dyn Asset>> {
            // Selecting a historical moment starts a bounded tool flow. Its
            // immutable snapshot must outlive eviction from the rolling cache.
            let lease = self
                .cache
                .keyframe(self.metadata.id, Instant::now())
                .ok_or_else(|| error("snapshot_expired"))?;
            copy_snapshot(&lease, self.info())
        }
    }
    struct ReservedHistorical {
        lease: crate::promoted_keyframes::KeyframeLease,
        info: SourceInfo,
    }
    impl Asset for ReservedHistorical {
        fn info(&self) -> SourceInfo {
            self.info.clone()
        }
        fn available(&self) -> bool {
            self.lease.is_available()
        }
        fn read(&self) -> Result<Pixels> {
            self.lease
                .readback()
                .map(pixels)
                .map_err(|_| error("snapshot_expired"))
        }
        fn snapshot(&self) -> Result<Arc<dyn Asset>> {
            copy_snapshot(&self.lease, self.info())
        }
    }
}
