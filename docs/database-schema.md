# RewindOS - Database Schema

## Overview

Single SQLite database at `~/.rewindos/rewindos.db`.

**SQLite Configuration:**
- WAL journal mode (concurrent reads during writes)
- FTS5 for full-text search
- sqlite-vec for vector similarity search (KNN)
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
    file_path       TEXT NOT NULL,            -- Path to WebP screenshot
    thumbnail_path  TEXT,                     -- Path to thumbnail WebP
    width           INTEGER NOT NULL,
    height          INTEGER NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    perceptual_hash BLOB NOT NULL,           -- 8-byte gradient hash (image-hasher)
    ocr_status      TEXT NOT NULL DEFAULT 'pending',       -- 'pending', 'processing', 'done', 'failed'
    embedding_status TEXT NOT NULL DEFAULT 'pending',      -- 'pending', 'done' (V002)
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_screenshots_timestamp ON screenshots(timestamp);
CREATE INDEX idx_screenshots_app_name ON screenshots(app_name);
CREATE INDEX idx_screenshots_window_class ON screenshots(window_class);
CREATE INDEX idx_screenshots_ocr_status ON screenshots(ocr_status);
CREATE INDEX idx_screenshots_hash ON screenshots(perceptual_hash);
```

### ocr_fts (FTS5 Virtual Table)

Full-text search index for OCR-extracted text. Uses a standalone content design
where `screenshot_id` is stored in the FTS table directly.

```sql
CREATE VIRTUAL TABLE ocr_fts USING fts5(
    text_content,
    screenshot_id UNINDEXED,
    tokenize='unicode61 remove_diacritics 2'
);
```

### ocr_text_content

Backing content table for OCR text (separate from FTS for flexibility).

```sql
CREATE TABLE ocr_text_content (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    screenshot_id   INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
    text_content    TEXT NOT NULL,
    word_count      INTEGER NOT NULL DEFAULT 0,
    UNIQUE(screenshot_id)
);

CREATE INDEX idx_ocr_screenshot ON ocr_text_content(screenshot_id);
```

### ocr_bounding_boxes

Stores individual text regions with coordinates for click-to-copy.

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

### ocr_embeddings (V002 — sqlite-vec virtual table)

Vector embeddings for semantic search, using sqlite-vec's `vec0` module.

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS ocr_embeddings USING vec0(
    screenshot_id INTEGER PRIMARY KEY,
    embedding float[768]
);
```

- Stores 768-dimensional float32 embeddings from `nomic-embed-text`
- Supports KNN nearest-neighbor search via `WHERE embedding MATCH ?`
- `screenshot_id` links back to `screenshots.id`
- `embedding_status` on `screenshots` tracks which rows have been embedded

### daemon_state

Persistent daemon state (survives restarts).

```sql
CREATE TABLE daemon_state (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Migrations

```
crates/rewindos-core/migrations/
├── V001__initial_schema.sql     # screenshots, ocr_fts, ocr_text_content, ocr_bounding_boxes, daemon_state
└── V002__vector_embeddings.sql  # embedding_status column + ocr_embeddings vec0 table
```

Migrations run automatically on database open (both daemon and Tauri app).

## Key Queries

### Full-text search with filters and snippet highlighting

```sql
SELECT s.id, s.timestamp, s.app_name, s.window_title,
       s.thumbnail_path, s.file_path,
       snippet(ocr_fts, 0, '<mark>', '</mark>', '...', 32) AS matched_text,
       rank
FROM ocr_fts
JOIN screenshots s ON s.id = ocr_fts.screenshot_id
WHERE ocr_fts MATCH ?1
  AND (?2 IS NULL OR s.timestamp >= ?2)
  AND (?3 IS NULL OR s.timestamp <= ?3)
  AND (?4 IS NULL OR s.app_name = ?4)
ORDER BY rank
LIMIT ?5 OFFSET ?6;
```

### Vector KNN search (semantic)

```sql
SELECT screenshot_id, distance
FROM ocr_embeddings
WHERE embedding MATCH ?1   -- query embedding as blob
ORDER BY distance
LIMIT ?2;
```

### Batch fetch perceptual hashes (for scene dedup)

```sql
SELECT id, perceptual_hash
FROM screenshots
WHERE id IN (?, ?, ?, ...);
```

### Pending embeddings (for backfill)

```sql
SELECT s.id, otc.text_content
FROM screenshots s
JOIN ocr_text_content otc ON otc.screenshot_id = s.id
WHERE s.ocr_status = 'done'
  AND s.embedding_status = 'pending'
ORDER BY s.id
LIMIT ?1;
```

### Deduplication check (capture-time)

```sql
SELECT id, perceptual_hash
FROM screenshots
WHERE timestamp > ?1
ORDER BY timestamp DESC
LIMIT ?2;
-- Then compute hamming distance in Rust
```

### Retention cleanup

```sql
DELETE FROM screenshots WHERE timestamp < ?1;
-- CASCADE deletes handle ocr_text_content and ocr_bounding_boxes
-- Application code also deletes corresponding WebP files from disk
-- FTS5 entries deleted separately (standalone table, no cascade)
```

## Storage Notes

- FTS5 index adds ~30-50% overhead on top of raw text storage
- sqlite-vec embeddings: 768 × 4 bytes = ~3KB per screenshot
- WAL file can grow during heavy writes; checkpoint after bulk cleanup
- Expected DB size for 90 days: ~200-500MB (FTS5 + embeddings)
