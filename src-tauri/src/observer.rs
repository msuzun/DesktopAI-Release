//! Local-only observations. No encoding, network, or observation pixels cross IPC.
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use std::time::Instant;

const W: u32 = 160;
const H: u32 = 96;
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualChangeEvent {
    pub kind: &'static str,
    pub timestamp_unix_ms: u64,
    pub global_score: f64,
    pub changed_area_ratio: f64,
    pub region_score: f64,
    pub temporal_confidence: f64,
    pub bounding_region: Option<Region>,
    pub stable: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub last_event: Option<VisualChangeEvent>,
    pub active: bool,
    pub interval_ms: u64,
    pub stabilization_ms: u64,
    pub observation_count: u64,
    pub meaningful_count: u64,
    pub processing_ms: f64,
    pub last_detection_latency_ms: Option<f64>,
    pub last_change_type: Option<&'static str>,
    pub global_score: f64,
    pub changed_area_ratio: f64,
    pub region_score: f64,
    pub temporal_confidence: f64,
    pub changed_tiles: Vec<usize>,
    pub bounding_region: Option<Region>,
    pub stable: bool,
    pub stabilization_duration_ms: u64,
    pub detected_at: Option<u64>,
    pub stable_at: Option<u64>,
    pub error: Option<&'static str>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            last_event: None,
            active: false,
            interval_ms: 250,
            stabilization_ms: 500,
            observation_count: 0,
            meaningful_count: 0,
            processing_ms: 0.,
            last_detection_latency_ms: None,
            last_change_type: None,
            global_score: 0.,
            changed_area_ratio: 0.,
            region_score: 0.,
            temporal_confidence: 0.,
            changed_tiles: vec![],
            bounding_region: None,
            stable: true,
            stabilization_duration_ms: 0,
            detected_at: None,
            stable_at: None,
            error: None,
        }
    }
}
#[derive(Clone)]
struct Small {
    pixels: Vec<[u8; 3]>,
    dimensions: (u32, u32),
}
impl Small {
    fn sample(image: &RgbaImage) -> Self {
        // Four samples per cell; work is independent of desktop resolution.
        let mut pixels = Vec::with_capacity((W * H) as usize);
        for y in 0..H {
            for x in 0..W {
                let mut sum = [0u32; 3];
                for (dx, dy) in [(1, 1), (3, 1), (1, 3), (3, 3)] {
                    let px = ((x * 4 + dx) as u64 * image.width() as u64 / (W * 4) as u64) as u32;
                    let py = ((y * 4 + dy) as u64 * image.height() as u64 / (H * 4) as u64) as u32;
                    let p = image.get_pixel(px.min(image.width() - 1), py.min(image.height() - 1));
                    for c in 0..3 {
                        sum[c] += p[c] as u32;
                    }
                }
                pixels.push(sum.map(|v| (v / 4) as u8));
            }
        }
        Self {
            pixels,
            dimensions: image.dimensions(),
        }
    }
}
struct Difference {
    global: f64,
    area: f64,
    peak: f64,
    tiles: Vec<usize>,
    bounds: Option<Region>,
}
fn compare(a: &Small, b: &Small) -> Difference {
    let mut sums = [0.; 64];
    let mut changed = 0;
    for (i, (a, b)) in a.pixels.iter().zip(&b.pixels).enumerate() {
        let d = (0..3).map(|c| a[c].abs_diff(b[c]) as f64).sum::<f64>() / 765.;
        sums[(i / W as usize / 12) * 8 + (i % W as usize / 20)] += d;
        if d > 0.08 {
            changed += 1;
        }
    }
    for v in &mut sums {
        *v /= 240.;
    }
    let tiles: Vec<usize> = sums
        .iter()
        .enumerate()
        .filter_map(|(i, v)| (*v > 0.04).then_some(i))
        .collect();
    let bounds = if tiles.is_empty() {
        None
    } else {
        let left = tiles.iter().map(|i| i % 8).min().unwrap() as u32;
        let top = tiles.iter().map(|i| i / 8).min().unwrap() as u32;
        let right = tiles.iter().map(|i| i % 8 + 1).max().unwrap() as u32;
        let bottom = tiles.iter().map(|i| i / 8 + 1).max().unwrap() as u32;
        let (w, h) = b.dimensions;
        Some(Region {
            x: left * w / 8,
            y: top * h / 8,
            width: right * w / 8 - left * w / 8,
            height: bottom * h / 8 - top * h / 8,
        })
    };
    Difference {
        global: sums.iter().sum::<f64>() / 64.,
        area: changed as f64 / (W * H) as f64,
        peak: sums.iter().copied().fold(0., f64::max),
        tiles,
        bounds,
    }
}
#[derive(Default)]
pub struct Observer {
    pub snapshot: Snapshot,
    baseline: Option<Small>,
    previous: Option<Small>,
    candidate: Option<Small>,
    confirmations: u8,
    first_candidate: u64,
    last_motion: u64,
}
impl Observer {
    pub fn reset(&mut self, active: bool) {
        let (interval, stabilization) = (self.snapshot.interval_ms, self.snapshot.stabilization_ms);
        *self = Self::default();
        self.snapshot.active = active;
        self.snapshot.interval_ms = interval;
        self.snapshot.stabilization_ms = stabilization;
    }
    pub fn observe(&mut self, image: &RgbaImage, now: u64, processing: f64) {
        if image.width() == 0 || image.height() == 0 {
            return;
        }
        let started = Instant::now();
        let current = Small::sample(image);
        let s = &mut self.snapshot;
        s.observation_count += 1;
        s.error = None;
        let reset = self
            .baseline
            .as_ref()
            .is_none_or(|b| b.dimensions != current.dimensions);
        if reset {
            self.baseline = Some(current.clone());
            self.previous = Some(current);
            self.candidate = None;
            self.confirmations = 0;
            s.stable = true;
            s.changed_tiles.clear();
            s.bounding_region = None;
            s.last_event = None;
            s.last_change_type = None;
            s.detected_at = None;
            s.stable_at = None;
            s.last_detection_latency_ms = None;
            s.region_score = 0.;
            s.stabilization_duration_ms = 0;
            self.last_motion = now;
            s.global_score = 0.;
            s.changed_area_ratio = 0.;
            s.temporal_confidence = 0.;
            s.processing_ms = processing + started.elapsed().as_secs_f64() * 1000.;
            return;
        }
        let diff = compare(self.baseline.as_ref().unwrap(), &current);
        let step = compare(self.previous.as_ref().unwrap(), &current);
        let motion = (step.area >= 0.003 && step.peak >= 0.04) || step.tiles.len() >= 32;
        if motion {
            self.last_motion = now;
            s.stable = false;
            s.stable_at = None;
        }
        let large = diff.global >= 0.18 || diff.area >= 0.4 || diff.tiles.len() >= 32;
        let eligible = diff.area >= 0.003 && diff.peak >= 0.08;
        if eligible {
            let persists = self.candidate.as_ref().is_some_and(|c| {
                let d = compare(c, &current);
                d.area < 0.003 && d.global < 0.015
            });
            if persists {
                self.confirmations = self.confirmations.saturating_add(1);
            } else {
                self.confirmations = 1;
                self.first_candidate = now;
            }
            self.candidate = Some(current.clone());
        } else {
            self.confirmations = 0;
            self.candidate = None;
        }
        s.global_score = diff.global;
        s.changed_area_ratio = diff.area;
        s.region_score = diff.peak;
        s.temporal_confidence = if large {
            1.
        } else {
            (self.confirmations as f64 / 3.).min(1.)
        };
        if large || self.confirmations >= 3 {
            s.meaningful_count += 1;
            s.last_change_type = Some(if large {
                "LARGE"
            } else if diff.area >= 0.025 {
                "MEDIUM"
            } else {
                "SMALL"
            });
            s.detected_at = Some(now);
            s.last_detection_latency_ms = Some(if large {
                processing
            } else {
                now.saturating_sub(self.first_candidate) as f64 + processing
            });
            s.changed_tiles = diff.tiles;
            s.bounding_region = diff.bounds;
            s.last_event = Some(VisualChangeEvent {
                kind: s.last_change_type.unwrap(),
                timestamp_unix_ms: now,
                global_score: diff.global,
                changed_area_ratio: diff.area,
                region_score: diff.peak,
                temporal_confidence: s.temporal_confidence,
                bounding_region: diff.bounds,
                stable: s.stable,
            });
            self.baseline = Some(current.clone());
            self.candidate = None;
            self.confirmations = 0;
        }
        s.stabilization_duration_ms = now.saturating_sub(self.last_motion);
        if !s.stable && s.stabilization_duration_ms >= s.stabilization_ms {
            s.stable = true;
            s.stable_at = Some(now);
        }
        s.processing_ms = processing + started.elapsed().as_secs_f64() * 1000.;
        if let Some(event) = s.last_event.as_mut() {
            event.stable = s.stable;
        }
        self.previous = Some(current);
    }
}
