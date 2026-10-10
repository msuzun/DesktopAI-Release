use super::model::*;
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub const MAX_PIXELS: u64 = 16 * 1024 * 1024;
pub const MAX_ASSET_BYTES: u64 = 32 * 1024 * 1024;
pub struct Asset {
    pub hash: String,
    pub bytes: Vec<u8>,
}
impl Asset {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self {
            hash: format!("{:x}", Sha256::digest(&bytes)),
            bytes,
        }
    }
}
pub struct PreparedAssets {
    pub visual: Option<Asset>,
    pub thumbnail: Option<Asset>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}
pub fn prepare(image: Option<image::RgbaImage>, mode: StorageMode) -> Result<PreparedAssets> {
    if mode == StorageMode::Metadata {
        return Ok(PreparedAssets {
            visual: None,
            thumbnail: None,
            width: None,
            height: None,
        });
    }
    let pixels = image.ok_or_else(|| MemoryError::new("MEMORY_SCREEN_UNAVAILABLE"))?;
    let (width, height) = pixels.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(MemoryError::new("MEMORY_IMAGE_TOO_LARGE"));
    }
    let source = DynamicImage::ImageRgba8(pixels);
    let thumbnail = source.resize(320, 200, FilterType::Triangle).to_rgb8();
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 75)
        .encode_image(&thumbnail)
        .map_err(|_| MemoryError::new("MEMORY_WRITE_FAILED"))?;
    let thumbnail = Some(Asset::new(bytes));
    let visual = if mode == StorageMode::Visual {
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 90)
            .encode_image(&source.to_rgb8())
            .map_err(|_| MemoryError::new("MEMORY_WRITE_FAILED"))?;
        if bytes.len() as u64 > MAX_ASSET_BYTES {
            return Err(MemoryError::new("MEMORY_IMAGE_TOO_LARGE"));
        }
        Some(Asset::new(bytes))
    } else {
        None
    };
    Ok(PreparedAssets {
        visual,
        thumbnail,
        width: Some(width),
        height: Some(height),
    })
}

/// Only fixed, hash-derived direct children are accepted. No imported or IPC
/// filesystem paths are ever interpreted here. Refuse links/reparse points.
fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
pub fn reject_link(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if is_link(&meta) => Err(MemoryError::new("MEMORY_PERMISSION_DENIED")),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
pub struct AssetStore {
    root: PathBuf,
    scan: Option<fs::ReadDir>,
}
impl AssetStore {
    pub fn new(root: &Path) -> Result<Self> {
        reject_link(root)?;
        fs::create_dir_all(root)?;
        let root = fs::canonicalize(root)?;
        let assets = root.join("assets");
        reject_link(&assets)?;
        fs::create_dir_all(&assets)?;
        Ok(Self {
            root: assets,
            scan: None,
        })
    }
    fn path(&self, hash: &str) -> Result<PathBuf> {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(MemoryError::new("MEMORY_INVALID_REQUEST"));
        }
        reject_link(&self.root)?;
        let path = self.root.join(format!("{hash}.jpg"));
        reject_link(&path)?;
        Ok(path)
    }
    pub fn write(&self, asset: &Asset) -> Result<()> {
        let target = self.path(&asset.hash)?;
        if target.exists() {
            let existing = self.read(&asset.hash)?;
            if existing != asset.bytes {
                return Err(MemoryError::new("MEMORY_ASSET_CORRUPT"));
            }
            return Ok(());
        }
        let temporary = self.root.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        let outcome = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&asset.bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, target)?;
            Ok(())
        })();
        if outcome.is_err() {
            let _ = fs::remove_file(temporary);
        }
        outcome
    }
    pub fn read(&self, hash: &str) -> Result<Vec<u8>> {
        let path = self.path(hash)?;
        let meta = fs::metadata(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                MemoryError::new("MEMORY_ASSET_MISSING")
            } else {
                e.into()
            }
        })?;
        if meta.len() > MAX_ASSET_BYTES {
            return Err(MemoryError::new("MEMORY_ASSET_CORRUPT"));
        }
        let bytes = fs::read(path)?;
        if format!("{:x}", Sha256::digest(&bytes)) != hash {
            return Err(MemoryError::new("MEMORY_ASSET_CORRUPT"));
        }
        Ok(bytes)
    }
    pub fn delete(&self, hash: &str) -> Result<()> {
        match fs::remove_file(self.path(hash)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
    /// Explicit maintenance, never startup. Unknown names are left alone;
    /// application-owned temporary files and unreferenced hashes are removed.
    pub fn reconcile(&self, referenced: &std::collections::HashSet<String>) -> Result<()> {
        reject_link(&self.root)?;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            reject_link(&path)?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(hash) = name.strip_suffix(".jpg") {
                if !referenced.contains(hash) && self.path(hash).is_ok() {
                    self.delete(hash)?;
                }
            } else if name
                .strip_suffix(".tmp")
                .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
            {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }
    /// Amortized crash recovery: at most 64 filenames per idle tick, no image
    /// decode or full-library startup scan. ReadDir carries the scan position.
    pub fn reconcile_batch(
        &mut self,
        mut referenced: impl FnMut(&str) -> Result<bool>,
    ) -> Result<()> {
        reject_link(&self.root)?;
        if self.scan.is_none() {
            self.scan = Some(fs::read_dir(&self.root)?);
        }
        for _ in 0..64 {
            let entry = match self.scan.as_mut().and_then(|scan| scan.next()) {
                Some(entry) => entry?,
                None => {
                    self.scan = None;
                    break;
                }
            };
            let path = entry.path();
            reject_link(&path)?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(hash) = name.strip_suffix(".jpg") {
                if self.path(hash).is_ok() && !referenced(hash)? {
                    self.delete(hash)?;
                }
            } else if name
                .strip_suffix(".tmp")
                .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
            {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }
}
