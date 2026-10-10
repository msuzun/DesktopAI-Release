//! Current/previous GPU analysis. Successful results also feed volatile Tier A history.
use crate::perception::FrameMetadata;
use serde::Serialize;

#[cfg(windows)]
mod gpu;
#[cfg(windows)]
mod worker;
#[cfg(windows)]
pub use worker::{AnalysisEngine, Snapshot};
pub const MAX_TILES: usize = 144;
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisConfig {
    pub max_width: u32,
    pub max_height: u32,
    pub tile_columns: u32,
    pub tile_rows: u32,
    pub pixel_noise_threshold: f32,
    pub tile_change_threshold: f32,
    pub medium_area: f64,
    pub medium_score: f64,
    pub medium_coverage: f64,
    pub large_area: f64,
    pub large_score: f64,
    pub large_coverage: f64,
}
impl Default for AnalysisConfig {
    fn default() -> Self {
        Self {
            max_width: 320,
            max_height: 180,
            tile_columns: 16,
            tile_rows: 9,
            pixel_noise_threshold: 2. / 255.,
            tile_change_threshold: 0.015,
            medium_area: 0.06,
            medium_score: 0.025,
            medium_coverage: 0.06,
            large_area: 0.35,
            large_score: 0.12,
            large_coverage: 0.30,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisError {
    pub stage: &'static str,
    pub message: &'static str,
    pub recoverable: bool,
    pub hresult: Option<i32>,
}
impl AnalysisError {
    pub fn new(stage: &'static str, message: &'static str, recoverable: bool) -> Self {
        Self {
            stage,
            message,
            recoverable,
            hresult: None,
        }
    }
    #[cfg(windows)]
    fn windows(stage: &'static str, error: windows::core::Error) -> Self {
        Self {
            hresult: Some(error.code().0),
            ..Self::new(
                stage,
                "GPU analysis failed. Stop and restart Screen Awareness.",
                false,
            )
        }
    }
}
pub type Result<T> = std::result::Result<T, AnalysisError>;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    pub source_width: u32,
    pub source_height: u32,
    pub analysis_width: u32,
    pub analysis_height: u32,
    pub tile_columns: u32,
    pub tile_rows: u32,
}
impl Geometry {
    pub fn new(width: u32, height: u32, c: AnalysisConfig) -> Result<Self> {
        if width == 0
            || height == 0
            || c.max_width == 0
            || c.max_height == 0
            || c.tile_columns == 0
            || c.tile_rows == 0
            || c.tile_columns as u64 * c.tile_rows as u64 > MAX_TILES as u64
        {
            return Err(AnalysisError::new(
                "geometry",
                "Invalid analysis dimensions or tile grid.",
                true,
            ));
        }
        let scale = (c.max_width as f64 / width as f64)
            .min(c.max_height as f64 / height as f64)
            .min(1.);
        let aw = ((width as f64 * scale).round() as u32).max(1);
        let ah = ((height as f64 * scale).round() as u32).max(1);
        Ok(Self {
            source_width: width,
            source_height: height,
            analysis_width: aw,
            analysis_height: ah,
            tile_columns: c.tile_columns.min(aw),
            tile_rows: c.tile_rows.min(ah),
        })
    }
    pub fn tile_count(self) -> usize {
        (self.tile_columns * self.tile_rows) as usize
    }
    // Identical integer partitions in HLSL: every pixel belongs to exactly one
    // row-major tile, including non-divisible edges and tiny source images.
    pub fn tile_rect(self, index: usize) -> (u32, u32, u32, u32) {
        let x = index as u32 % self.tile_columns;
        let y = index as u32 / self.tile_columns;
        (
            x * self.analysis_width / self.tile_columns,
            y * self.analysis_height / self.tile_rows,
            (x + 1) * self.analysis_width / self.tile_columns,
            (y + 1) * self.analysis_height / self.tile_rows,
        )
    }
}

// Exactly matches the HLSL StructuredBuffer element: <=144 * 16 = 2304 bytes.
// M7.4 separately reads the already-downsampled luma, never the source image.
#[derive(Clone, Copy, Default, Debug)]
#[repr(C)]
pub struct GpuTile {
    pub difference_sum: f32,
    pub changed_pixels: u32,
    pub pixel_count: u32,
    pub padding: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub enum Classification {
    #[serde(rename = "NoChange")]
    None,
    #[serde(rename = "SmallChange")]
    Small,
    #[serde(rename = "MediumChange")]
    Medium,
    #[serde(rename = "LargeChange")]
    Large,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub enum ResultKind {
    BaselineEstablished,
    Analyzed,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileMetric {
    pub average_difference: f64,
    pub changed_pixel_ratio: f64,
    pub changed: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeMetrics {
    pub global_change_score: f64,
    pub changed_area_ratio: f64,
    pub changed_tile_count: u32,
    pub total_tile_count: u32,
    pub change_bounds: Option<Bounds>,
    pub classification: Classification,
    pub tiles: Vec<TileMetric>,
}

fn classify(score: f64, area: f64, changed: u32, total: u32, c: AnalysisConfig) -> Classification {
    if changed == 0 {
        return Classification::None;
    }
    let coverage = changed as f64 / total as f64;
    if area >= c.large_area || (score >= c.large_score && coverage >= c.large_coverage) {
        Classification::Large
    } else if area >= c.medium_area || (score >= c.medium_score && coverage >= c.medium_coverage) {
        Classification::Medium
    } else {
        Classification::Small
    }
}

pub fn reduce_tiles(
    geometry: Geometry,
    tiles: &[GpuTile],
    c: AnalysisConfig,
) -> Result<ChangeMetrics> {
    if tiles.len() != geometry.tile_count() {
        return Err(AnalysisError::new(
            "tile_readback",
            "Unexpected tile count.",
            true,
        ));
    }
    let (mut sum, mut changed_pixels, mut changed_tiles) = (0., 0u32, 0u32);
    let mut extent: Option<(u32, u32, u32, u32)> = None;
    let mut metrics = Vec::with_capacity(tiles.len()); // One small owned metadata array; no pixel buffer.
    for (index, tile) in tiles.iter().enumerate() {
        let (x0, y0, x1, y1) = geometry.tile_rect(index);
        let pixels = (x1 - x0) * (y1 - y0);
        if tile.pixel_count != pixels
            || tile.changed_pixels > pixels
            || !tile.difference_sum.is_finite()
            || tile.difference_sum < 0.
            || tile.difference_sum > pixels as f32 + 0.001
        {
            return Err(AnalysisError::new(
                "tile_readback",
                "Invalid GPU tile metrics.",
                true,
            ));
        }
        let average = (tile.difference_sum as f64 / pixels as f64).clamp(0., 1.);
        let changed = average > c.tile_change_threshold as f64;
        if changed {
            changed_tiles += 1;
            extent = Some(match extent {
                None => (x0, y0, x1, y1),
                Some((a, b, d, e)) => (a.min(x0), b.min(y0), d.max(x1), e.max(y1)),
            });
        }
        sum += tile.difference_sum as f64;
        changed_pixels += tile.changed_pixels;
        metrics.push(TileMetric {
            average_difference: average,
            changed_pixel_ratio: tile.changed_pixels as f64 / pixels as f64,
            changed,
        });
    }
    let pixels = (geometry.analysis_width * geometry.analysis_height) as f64;
    // Global score = sum(abs(luma_now-luma_previous) above noise floor) / all
    // analysis pixels. Area counts pixels above the same noise floor, independently
    // of intensity. Tile thresholds affect bounds/classification, not these scores.
    let score = (sum / pixels).clamp(0., 1.);
    let area = (changed_pixels as f64 / pixels).clamp(0., 1.);
    let bounds = extent.map(|(x0, y0, x1, y1)| Bounds {
        x: x0 as f64 / geometry.analysis_width as f64,
        y: y0 as f64 / geometry.analysis_height as f64,
        width: (x1 - x0) as f64 / geometry.analysis_width as f64,
        height: (y1 - y0) as f64 / geometry.analysis_height as f64,
    });
    Ok(ChangeMetrics {
        global_change_score: score,
        changed_area_ratio: area,
        changed_tile_count: changed_tiles,
        total_tile_count: tiles.len() as u32,
        change_bounds: bounds,
        classification: classify(score, area, changed_tiles, tiles.len() as u32, c),
        tiles: metrics,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualAnalysisResult {
    pub kind: ResultKind,
    pub capture_generation: u64,
    pub source_frame_id: u64,
    pub previous_source_frame_id: Option<u64>,
    pub perception_sequence: u64,
    pub analysis_sequence: u64,
    pub geometry: Geometry,
    pub metrics: Option<ChangeMetrics>,
    pub analysis_total_ms: f64,
    pub dispatch_cpu_ms: f64,
    pub completion_readback_latency_ms: f64,
    pub cpu_result_processing_ms: f64,
    pub source_age_at_publication_ms: f64,
    pub perception_to_publication_ms: f64,
}

#[derive(Default)]
pub struct TemporalState {
    topology: Option<(u64, u32, u32, &'static str)>,
    last_seen: Option<(u64, u64)>,
    previous: Option<u64>,
    sequence: u64,
    pub resets: u64,
    pub skipped: u64,
}
pub struct Ticket {
    pub sequence: u64,
    pub previous: Option<u64>,
    pub source: u64,
}
impl TemporalState {
    // Accept each source/perception pair once. Failed/skipped analysis never
    // advances `previous`; only a validated completed readback may commit it.
    pub fn accept(
        &mut self,
        source: FrameMetadata,
        perception: u64,
        resources_rebuilt: bool,
    ) -> Option<Ticket> {
        if self
            .topology
            .is_some_and(|t| source.capture_generation < t.0)
        {
            return None;
        }
        let topology = (
            source.capture_generation,
            source.width,
            source.height,
            source.pixel_format,
        );
        let changed_generation = self.topology.is_some_and(|t| t.0 != topology.0);
        if changed_generation {
            self.last_seen = None;
        }
        if self
            .last_seen
            .is_some_and(|(frame, seq)| source.frame_id <= frame || perception <= seq)
        {
            return None;
        }
        if self.topology != Some(topology) || resources_rebuilt {
            if self.topology.is_some() {
                self.resets += 1;
            }
            self.previous = None;
            self.topology = Some(topology);
        }
        if let Some((_, sequence)) = self.last_seen {
            self.skipped += perception - sequence - 1;
        } else {
            self.skipped += perception.saturating_sub(1);
        }
        self.last_seen = Some((source.frame_id, perception));
        self.sequence += 1;
        Some(Ticket {
            sequence: self.sequence,
            previous: self.previous,
            source: source.frame_id,
        })
    }
    pub fn commit(&mut self, ticket: &Ticket) {
        self.previous = Some(ticket.source);
    }
}
