use super::{
    assets::{reject_link, Asset, AssetStore},
    model::*,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

const COLUMNS: &str = "id, observed_at, persisted_at, session_id, event_kind, summary, summary_source, source_application, window_title, save_reason, bookmarked, visual_hash IS NOT NULL, thumbnail_hash IS NOT NULL, width, height, expires_at";
pub trait PersistentMemoryRepository {
    fn insert(
        &mut self,
        record: &MemoryRecord,
        visual: Option<&Asset>,
        thumbnail: Option<&Asset>,
    ) -> Result<()>;
    fn get(&self, id: &str) -> Result<MemoryRecord>;
    fn search(&self, query: &MemoryQuery) -> Result<MemoryPage>;
    fn delete(&mut self, id: &str) -> Result<()>;
    fn bookmark(&mut self, id: &str, bookmarked: bool) -> Result<MemoryRecord>;
}
pub struct SqliteMemoryRepository {
    pub(crate) connection: Connection,
    root: PathBuf,
    pub assets: AssetStore,
}
fn row_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRecord> {
    Ok(MemoryRecord {
        id: row.get(0)?,
        observed_at: row.get(1)?,
        persisted_at: row.get(2)?,
        session_id: row.get(3)?,
        event_kind: row.get(4)?,
        summary: row.get(5)?,
        summary_source: row.get(6)?,
        source_application: row.get(7)?,
        window_title: row.get(8)?,
        save_reason: row.get(9)?,
        bookmarked: row.get(10)?,
        has_visual: row.get(11)?,
        has_thumbnail: row.get(12)?,
        width: row.get(13)?,
        height: row.get(14)?,
        expires_at: row.get(15)?,
    })
}
impl SqliteMemoryRepository {
    pub fn open(root: &Path) -> Result<Self> {
        let assets = AssetStore::new(root)?;
        for file in ["memory.sqlite3", "memory.sqlite3-wal", "memory.sqlite3-shm"] {
            reject_link(&root.join(file))?;
        }
        let mut connection = Connection::open(root.join("memory.sqlite3"))?;
        connection.busy_timeout(Duration::from_millis(300))?;
        let version: u32 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > 1 {
            return Err(MemoryError::new("MEMORY_SCHEMA_TOO_NEW"));
        }
        // A library has one owner across processes, not merely one thread in
        // this process. EXCLUSIVE WAL ownership prevents another app instance's
        // orphan recovery or clear from racing a pending asset publication.
        // Explicitly acquire the lock now; a second owner fails within the
        // bounded busy timeout while the rest of that app remains usable.
        connection.execute_batch("PRAGMA locking_mode=EXCLUSIVE; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA wal_autocheckpoint=128; BEGIN EXCLUSIVE; COMMIT;")?;
        if version == 0 {
            let transaction = connection.transaction()?;
            transaction
                .execute_batch(include_str!("migrations/001_initial.sql"))
                .map_err(|_| MemoryError::new("MEMORY_MIGRATION_FAILED"))?;
            transaction
                .commit()
                .map_err(|_| MemoryError::new("MEMORY_MIGRATION_FAILED"))?;
        }
        Ok(Self {
            connection,
            root: root.to_path_buf(),
            assets,
        })
    }
    pub fn settings(&self) -> Result<MemorySettings> {
        let value: Option<String> = self
            .connection
            .query_row("SELECT value FROM settings WHERE id=1", [], |r| r.get(0))
            .optional()?;
        let settings: MemorySettings = value
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|_| MemoryError::new("MEMORY_SETTINGS_INVALID"))?
            .unwrap_or_default();
        settings.validate()?;
        Ok(settings)
    }
    pub fn configure(&mut self, settings: &MemorySettings) -> Result<()> {
        settings.validate()?;
        self.connection.execute("INSERT INTO settings(id,value) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(settings).map_err(|_| MemoryError::new("MEMORY_INVALID_REQUEST"))?])?;
        // Retention preference applies to existing unprotected and protected rows;
        // bookmarks remain exempt during cleanup until explicitly unbookmarked.
        self.connection.execute(
            "UPDATE memories SET expires_at=observed_at+?1",
            [i64::from(settings.retention_days) * 86_400_000],
        )?;
        Ok(())
    }
    pub fn count(&self) -> Result<u64> {
        Ok(self
            .connection
            .query_row("SELECT count(*) FROM memories", [], |r| r.get::<_, i64>(0))?
            as u64)
    }
    pub fn storage_bytes(&self) -> Result<u64> {
        let assets: i64 = self.connection.query_row(
            "SELECT COALESCE(sum(byte_size),0) FROM assets",
            [],
            |r| r.get(0),
        )?;
        let mut total = assets.max(0) as u64;
        for file in ["memory.sqlite3", "memory.sqlite3-wal", "memory.sqlite3-shm"] {
            match std::fs::metadata(self.root.join(file)) {
                Ok(meta) => total = total.saturating_add(meta.len()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(total)
    }
    pub fn storage_breakdown(&self) -> Result<(u64, u64, u64)> {
        let visuals:i64=self.connection.query_row("SELECT COALESCE(sum(byte_size),0) FROM assets WHERE EXISTS(SELECT 1 FROM memories WHERE visual_hash=hash)",[],|r|r.get(0))?;
        let thumbnails:i64=self.connection.query_row("SELECT COALESCE(sum(byte_size),0) FROM assets WHERE EXISTS(SELECT 1 FROM memories WHERE thumbnail_hash=hash) AND NOT EXISTS(SELECT 1 FROM memories WHERE visual_hash=hash)",[],|r|r.get(0))?;
        let all_assets: i64 = self.connection.query_row(
            "SELECT COALESCE(sum(byte_size),0) FROM assets",
            [],
            |r| r.get(0),
        )?;
        Ok((
            self.storage_bytes()?
                .saturating_sub(all_assets.max(0) as u64),
            visuals.max(0) as u64,
            thumbnails.max(0) as u64,
        ))
    }
    pub fn duplicate(
        &self,
        record: &MemoryRecord,
        visual: Option<&Asset>,
        thumbnail: Option<&Asset>,
    ) -> Result<Option<MemoryRecord>> {
        let sql=format!("SELECT {COLUMNS} FROM memories WHERE session_id=?1 AND summary=?2 AND observed_at>=?3 AND observed_at<=?4 AND visual_hash IS ?5 AND thumbnail_hash IS ?6 AND event_kind=?7 ORDER BY observed_at DESC,id DESC LIMIT 1");
        Ok(self
            .connection
            .query_row(
                &sql,
                params![
                    record.session_id,
                    record.summary,
                    record.observed_at - 10_000,
                    record.observed_at,
                    visual.map(|a| &a.hash),
                    thumbnail.map(|a| &a.hash),
                    record.event_kind
                ],
                row_record,
            )
            .optional()?)
    }
    pub fn asset(&self, id: &str, thumbnail: bool) -> Result<Vec<u8>> {
        validate_id(id)?;
        let hash: Option<String> = self
            .connection
            .query_row(
                if thumbnail {
                    "SELECT thumbnail_hash FROM memories WHERE id=?1"
                } else {
                    "SELECT visual_hash FROM memories WHERE id=?1"
                },
                [id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        self.assets
            .read(&hash.ok_or_else(|| MemoryError::new("MEMORY_ASSET_MISSING"))?)
    }
    pub fn delete_range(&mut self, from: i64, to: i64) -> Result<u64> {
        if from > to {
            return Err(MemoryError::new("MEMORY_INVALID_REQUEST"));
        }
        let transaction = self.connection.transaction()?;
        let count = transaction.execute(
            "DELETE FROM memories WHERE observed_at>=?1 AND observed_at<=?2",
            params![from, to],
        )?;
        transaction.commit()?;
        self.collect_unreferenced()?;
        Ok(count as u64)
    }
    pub fn clear(&mut self) -> Result<()> {
        let transaction = self.connection.transaction()?;
        transaction.execute("DELETE FROM memories", [])?;
        transaction.commit()?;
        self.collect_unreferenced()?;
        self.assets.reconcile(&HashSet::new())?;
        self.connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }
    pub fn cleanup(
        &mut self,
        now: i64,
        settings: &MemorySettings,
        extra_bytes: u64,
    ) -> Result<u64> {
        let budget = u64::from(settings.storage_limit_mb) * 1024 * 1024;
        // Deleting rows cannot shrink SQLite's allocated pages without VACUUM.
        // Reject a candidate that cannot fit even after every visual asset is
        // evicted, before touching any existing user memories. page_count also
        // includes logical database growth still resident in WAL.
        if extra_bytes > 0 {
            let pages: i64 = self
                .connection
                .query_row("PRAGMA page_count", [], |r| r.get(0))?;
            let page_size: i64 = self
                .connection
                .query_row("PRAGMA page_size", [], |r| r.get(0))?;
            let minimum_database_bytes = (pages.max(0) as u64)
                .saturating_mul(page_size.max(0) as u64)
                .saturating_add(32 * 1024);
            if minimum_database_bytes.saturating_add(extra_bytes) > budget {
                return Err(MemoryError::new("MEMORY_STORAGE_FULL"));
            }
        }
        let count = self.connection.execute("DELETE FROM memories WHERE id IN (SELECT id FROM memories WHERE bookmarked=0 AND expires_at<=?1 ORDER BY expires_at,id LIMIT 128)", [now])?;
        self.collect_unreferenced_batch(128)?;
        let mut removed = count as u64;
        let mut evicted = 0;
        while self.storage_bytes()?.saturating_add(extra_bytes) > budget {
            if evicted >= 128 {
                return Err(MemoryError::new("MEMORY_STORAGE_FULL"));
            }
            // Deterministic stable ordering. Never silently evict bookmarks.
            let oldest: Option<String> = self
                .connection
                .query_row(
                    "SELECT id FROM memories WHERE bookmarked=0 ORDER BY observed_at,id LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(id) = oldest {
                self.delete(&id)?;
                removed += 1;
                evicted += 1;
            } else {
                return Err(MemoryError::new("MEMORY_STORAGE_FULL"));
            }
            self.connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        }
        Ok(removed)
    }
    pub fn maintenance(&mut self, now: i64, settings: &MemorySettings) -> Result<u64> {
        let cleanup = self.cleanup(now, settings, 0);
        // Even storage-full errors must permit orphan recovery to free space.
        let connection = &self.connection;
        self.assets.reconcile_batch(|hash| {
            Ok(connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE hash=?1)",
                [hash],
                |r| r.get::<_, bool>(0),
            )?)
        })?;
        cleanup
    }
    pub fn discard_unreferenced(&mut self, assets: &[&Asset]) -> Result<()> {
        for asset in assets {
            let references: i64 = self.connection.query_row(
                "SELECT count(*) FROM memories WHERE visual_hash=?1 OR thumbnail_hash=?1",
                [&asset.hash],
                |r| r.get(0),
            )?;
            if references == 0 {
                self.assets.delete(&asset.hash)?;
            }
        }
        Ok(())
    }
    fn collect_unreferenced(&mut self) -> Result<()> {
        self.collect_unreferenced_batch(i64::MAX)
    }
    fn collect_unreferenced_batch(&mut self, limit: i64) -> Result<()> {
        // Keep unreferenced asset metadata until deletion succeeds, allowing a
        // failed file unlink to be retried and counted against the storage limit.
        self.connection.execute("INSERT OR IGNORE INTO orphan_assets SELECT hash FROM assets WHERE NOT EXISTS(SELECT 1 FROM memories WHERE visual_hash=hash OR thumbnail_hash=hash) LIMIT ?1", [limit])?;
        let hashes = self
            .connection
            .prepare("SELECT hash FROM orphan_assets LIMIT ?1")?
            .query_map([limit], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut failure = None;
        for hash in hashes {
            let references: i64 = self.connection.query_row(
                "SELECT count(*) FROM memories WHERE visual_hash=?1 OR thumbnail_hash=?1",
                [&hash],
                |r| r.get(0),
            )?;
            if references != 0 {
                self.connection
                    .execute("DELETE FROM orphan_assets WHERE hash=?1", [&hash])?;
                continue;
            }
            if let Err(error) = self.assets.delete(&hash) {
                failure = Some(error);
                continue;
            }
            let transaction = self.connection.transaction()?;
            transaction.execute("DELETE FROM orphan_assets WHERE hash=?1", [&hash])?;
            transaction.execute("DELETE FROM assets WHERE hash=?1", [&hash])?;
            transaction.commit()?;
        }
        // Row deletion stays committed even when file cleanup fails. The stable
        // code makes incomplete disk removal visible rather than claiming clear.
        match failure {
            Some(_) => Err(MemoryError::new("MEMORY_CLEANUP_INCOMPLETE")),
            None => Ok(()),
        }
    }
}
impl PersistentMemoryRepository for SqliteMemoryRepository {
    fn insert(
        &mut self,
        record: &MemoryRecord,
        visual: Option<&Asset>,
        thumbnail: Option<&Asset>,
    ) -> Result<()> {
        let transaction = self.connection.transaction()?;
        for asset in [visual, thumbnail].into_iter().flatten() {
            transaction.execute(
                "INSERT OR IGNORE INTO assets(hash,byte_size) VALUES(?1,?2)",
                params![asset.hash, asset.bytes.len() as i64],
            )?;
        }
        transaction.execute("INSERT INTO memories(id,observed_at,persisted_at,session_id,event_kind,summary,summary_source,source_application,window_title,save_reason,bookmarked,visual_hash,thumbnail_hash,width,height,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
            params![record.id,record.observed_at,record.persisted_at,record.session_id,record.event_kind,record.summary,record.summary_source,record.source_application,record.window_title,record.save_reason,record.bookmarked,visual.map(|a| &a.hash),thumbnail.map(|a| &a.hash),record.width,record.height,record.expires_at])?;
        transaction.commit()?;
        Ok(())
    }
    fn get(&self, id: &str) -> Result<MemoryRecord> {
        validate_id(id)?;
        self.connection
            .query_row(
                &format!("SELECT {COLUMNS} FROM memories WHERE id=?1"),
                [id],
                row_record,
            )
            .optional()?
            .ok_or_else(|| MemoryError::new("MEMORY_NOT_FOUND"))
    }
    fn search(&self, query: &MemoryQuery) -> Result<MemoryPage> {
        query.validate()?;
        let text = query
            .text
            .as_deref()
            .unwrap_or("")
            .trim()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{text}%");
        let limit = query.limit.unwrap_or(24).clamp(1, 50);
        let sql = format!("SELECT {COLUMNS} FROM memories WHERE (?1 IS NULL OR observed_at>=?1) AND (?2 IS NULL OR observed_at<=?2) AND (?3=0 OR bookmarked=1) AND (?4 IS NULL OR source_application=?4) AND (?5 IS NULL OR observed_at<?5 OR (observed_at=?5 AND id<?6)) AND (summary LIKE ?7 ESCAPE '\\' OR COALESCE(source_application,'') LIKE ?7 ESCAPE '\\') ORDER BY observed_at DESC,id DESC LIMIT ?8");
        let mut statement = self.connection.prepare(&sql)?;
        let mut items = statement
            .query_map(
                params![
                    query.from,
                    query.to,
                    query.bookmarked_only.unwrap_or(false),
                    query.source_application,
                    query.cursor.as_ref().map(|c| c.observed_at),
                    query.cursor.as_ref().map(|c| &c.id),
                    pattern,
                    limit + 1
                ],
                row_record,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let next_cursor = if items.len() > limit as usize {
            items.truncate(limit as usize);
            items.last().map(|r| MemoryCursor {
                observed_at: r.observed_at,
                id: r.id.clone(),
            })
        } else {
            None
        };
        Ok(MemoryPage { items, next_cursor })
    }
    fn delete(&mut self, id: &str) -> Result<()> {
        validate_id(id)?;
        self.connection
            .execute("DELETE FROM memories WHERE id=?1", [id])?;
        self.collect_unreferenced()
    }
    fn bookmark(&mut self, id: &str, bookmarked: bool) -> Result<MemoryRecord> {
        validate_id(id)?;
        self.connection.execute(
            "UPDATE memories SET bookmarked=?2 WHERE id=?1",
            params![id, bookmarked],
        )?;
        self.get(id)
    }
}
