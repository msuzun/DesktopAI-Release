CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
CREATE TABLE assets (
    hash TEXT PRIMARY KEY CHECK(length(hash) = 64),
    byte_size INTEGER NOT NULL CHECK(byte_size >= 0)
);
CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    persisted_at INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    summary_source TEXT NOT NULL,
    source_application TEXT,
    window_title TEXT,
    save_reason TEXT NOT NULL,
    bookmarked INTEGER NOT NULL DEFAULT 0,
    visual_hash TEXT REFERENCES assets(hash),
    thumbnail_hash TEXT REFERENCES assets(hash),
    width INTEGER,
    height INTEGER,
    expires_at INTEGER
);
CREATE INDEX memories_timeline ON memories(observed_at DESC, id DESC);
CREATE INDEX memories_expiry ON memories(bookmarked, expires_at);
CREATE INDEX memories_application ON memories(source_application, observed_at DESC, id DESC);
CREATE INDEX memories_visual_asset ON memories(visual_hash);
CREATE INDEX memories_thumbnail_asset ON memories(thumbnail_hash);
CREATE INDEX memories_dedup ON memories(session_id, summary, observed_at DESC);
CREATE TABLE orphan_assets (hash TEXT PRIMARY KEY CHECK(length(hash) = 64));
PRAGMA user_version = 1;
