# RewindOS - Database Schema

## Overview

Single SQLite database at `~/.rewindos/rewindos.db`.

**SQLite Configuration:**
- WAL journal mode (concurrent reads during writes)
- FTS5 for full-text search
- Managed via refinery migrations

## PRAGMA Settings (applied on every connection)

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -20000;  -- 20MB cache
```

## Tables

### screenshots

Primary table storing metadata for each captured frame.

```sql
CREATE TABLE screenshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       INTEGER NOT NULL,        -- Unix timestamp (seconds)
    timestamp_ms    INTEGER NOT NULL,        -- Unix timestamp (milliseconds) for precision
    app_name        TEXT,                     -- Process name (e.g., "firefox", "code")
    window_title    TEXT,                     -- Window title at capture time
    window_class    TEXT,                     -- Window class/app_id for matching
    file_path       TEXT NOT NULL,            -- Relative path to WebP screenshot
    thumbnail_path  TEXT,                     -- Relative path to thumbnail WebP
    width           INTEGER NOT NULL,
    height          INTEGER NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    perceptual_hash BLOB NOT NULL,           -- 8-byte perceptual hash
    ocr_status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'processing', 'done', 'failed'
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_screenshots_timestamp ON screenshots(timestamp);
CREATE INDEX idx_screenshots_app_name ON screenshots(app_name);
CREATE INDEX idx_screenshots_window_class ON screenshots(window_class);
CREATE INDEX idx_screenshots_ocr_status ON screenshots(ocr_status);
CREATE INDEX idx_screenshots_hash ON screenshots(perceptual_hash);
```

### ocr_text (FTS5 Virtual Table)

Full-text search index for OCR-extracted text.

```sql
CREATE VIRTUAL TABLE ocr_text USING fts5(
    text_content,
    content='ocr_text_content',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

-- Backing content table (FTS5 external content)
CREATE TABLE ocr_text_content (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    screenshot_id   INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
    text_content    TEXT NOT NULL,            -- Full extracted text
    word_count      INTEGER NOT NULL DEFAULT 0,
    UNIQUE(screenshot_id)
);

CREATE INDEX idx_ocr_screenshot ON ocr_text_content(screenshot_id);

-- Triggers to keep FTS5 in sync with content table
CREATE TRIGGER ocr_text_ai AFTER INSERT ON ocr_text_content BEGIN
    INSERT INTO ocr_text(rowid, text_content)
    VALUES (new.id, new.text_content);
END;

CREATE TRIGGER ocr_text_ad AFTER DELETE ON ocr_text_content BEGIN
    INSERT INTO ocr_text(ocr_text, rowid, text_content)
    VALUES ('delete', old.id, old.text_content);
END;

CREATE TRIGGER ocr_text_au AFTER UPDATE ON ocr_text_content BEGIN
    INSERT INTO ocr_text(ocr_text, rowid, text_content)
    VALUES ('delete', old.id, old.text_content);
    INSERT INTO ocr_text(rowid, text_content)
    VALUES (new.id, new.text_content);
END;
```

### ocr_bounding_boxes

Stores individual text regions with coordinates for future click-to-copy.

```sql
CREATE TABLE ocr_bounding_boxes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    screenshot_id   INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
    text_content    TEXT NOT NULL,
    x               INTEGER NOT NULL,
    y               INTEGER NOT NULL,
    width           INTEGER NOT NULL,
    height          INTEGER NOT NULL,
    confidence      REAL                     -- Tesseract confidence (0-100)
);

CREATE INDEX idx_bbox_screenshot ON ocr_bounding_boxes(screenshot_id);
```

### app_sessions

Tracks contiguous usage of applications for future analytics.

```sql
CREATE TABLE app_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    app_name        TEXT NOT NULL,
    window_class    TEXT,
    start_time      INTEGER NOT NULL,        -- Unix timestamp
    end_time        INTEGER,                 -- NULL if ongoing
    duration_secs   INTEGER GENERATED ALWAYS AS (
                        CASE WHEN end_time IS NOT NULL
                        THEN end_time - start_time
                        ELSE NULL END
                    ) STORED
);

CREATE INDEX idx_sessions_app ON app_sessions(app_name);
CREATE INDEX idx_sessions_time ON app_sessions(start_time, end_time);
```

### daemon_state

Persistent daemon state (survives restarts).

```sql
CREATE TABLE daemon_state (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Stores: last_capture_timestamp, last_cleanup_timestamp, total_frames, etc.
```

## Key Queries

### Full-text search with filters

```sql
SELECT s.id, s.timestamp, s.app_name, s.window_title,
       s.thumbnail_path, s.file_path,
       snippet(ocr_text, 0, '<mark>', '</mark>', '...', 32) AS matched_text,
       rank
FROM ocr_text
JOIN ocr_text_content otc ON otc.id = ocr_text.rowid
JOIN screenshots s ON s.id = otc.screenshot_id
WHERE ocr_text MATCH ?1
  AND (?2 IS NULL OR s.timestamp >= ?2)    -- start_time filter
  AND (?3 IS NULL OR s.timestamp <= ?3)    -- end_time filter
  AND (?4 IS NULL OR s.app_name = ?4)      -- app filter
ORDER BY rank
LIMIT ?5 OFFSET ?6;
```

### Deduplication check (perceptual hash)

```sql
SELECT id, perceptual_hash
FROM screenshots
WHERE timestamp > ?1 - 30  -- Look back 30 seconds
ORDER BY timestamp DESC
LIMIT 10;
-- Then compute hamming distance in Rust
```

### Retention cleanup

```sql
DELETE FROM screenshots
WHERE timestamp < unixepoch() - (?1 * 86400);
-- CASCADE deletes handle ocr_text_content and ocr_bounding_boxes
-- Application code also deletes the corresponding WebP files from disk
```

### App usage summary (for future analytics)

```sql
SELECT app_name,
       COUNT(*) as frame_count,
       MIN(timestamp) as first_seen,
       MAX(timestamp) as last_seen
FROM screenshots
WHERE timestamp >= ?1 AND timestamp <= ?2
GROUP BY app_name
ORDER BY frame_count DESC;
```

## Migration Strategy

Using `refinery` crate with embedded SQL migrations.

```
crates/rewindos-core/migrations/
├── V001__initial_schema.sql     # Tables above
├── V002__add_indexes.sql        # Additional indexes if needed
└── ...
```

Migrations run automatically on daemon startup and Tauri app startup (whichever connects first).

## Storage Notes

- FTS5 index adds ~30-50% overhead on top of raw text storage
- `PRAGMA optimize` should be called periodically (e.g., daily or on 10k inserts)
- WAL file can grow during heavy writes; `PRAGMA wal_checkpoint(TRUNCATE)` after bulk cleanup
- Expected DB size for 90 days: ~200-500MB (mostly FTS5 index)
