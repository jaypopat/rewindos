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

### daily_summaries (V003)

AI-generated daily activity summaries.

```sql
CREATE TABLE daily_summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    date_key        TEXT NOT NULL UNIQUE,         -- 'YYYY-MM-DD'
    summary_text    TEXT NOT NULL,
    app_breakdown   TEXT,                          -- JSON object
    total_sessions  INTEGER,
    time_range      TEXT,
    model_name      TEXT,
    screenshot_count INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### bookmarks (V004)

Saved screenshots for quick access.

```sql
CREATE TABLE bookmarks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    screenshot_id   INTEGER NOT NULL UNIQUE REFERENCES screenshots(id) ON DELETE CASCADE,
    note            TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### collections (V004)

Named groups of screenshots.

```sql
CREATE TABLE collections (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    description     TEXT,
    color           TEXT,
    start_time      INTEGER,
    end_time        INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE collection_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id   INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    screenshot_id   INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
    added_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(collection_id, screenshot_id)
);
```

### journal_entries (V005 + V006)

Daily journal entries with rich text content.

```sql
CREATE TABLE journal_entries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    date            TEXT NOT NULL UNIQUE,          -- 'YYYY-MM-DD'
    content         TEXT NOT NULL,                  -- Tiptap JSON or HTML
    mood            INTEGER,                        -- 1-5 scale (V006)
    energy          INTEGER,                        -- 1-5 scale (V006)
    word_count      INTEGER DEFAULT 0,             -- (V006)
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE journal_screenshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id        INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    screenshot_id   INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
    caption         TEXT,
    sort_order      INTEGER DEFAULT 0,
    UNIQUE(entry_id, screenshot_id)
);
```

### journal_tags (V006)

Tag system for journal entries.

```sql
CREATE TABLE journal_tags (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    color           TEXT
);

CREATE TABLE journal_entry_tags (
    entry_id        INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    tag_id          INTEGER NOT NULL REFERENCES journal_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (entry_id, tag_id)
);
```

### journal_fts (V006)

Full-text search for journal content.

```sql
CREATE VIRTUAL TABLE journal_fts USING fts5(
    content,
    date UNINDEXED,
    entry_id UNINDEXED,
    tokenize='unicode61 remove_diacritics 2'
);
```

### journal_templates (V006)

Reusable journal prompt templates (4 built-in: Daily Reflection, Standup, Gratitude, Weekly Review).

```sql
CREATE TABLE journal_templates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    content         TEXT NOT NULL,
    is_builtin      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### journal_summaries (V006)

AI-generated journal summaries (daily/weekly).

```sql
CREATE TABLE journal_summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    period_type     TEXT NOT NULL,                  -- 'daily' or 'weekly'
    period_key      TEXT NOT NULL,                  -- 'YYYY-MM-DD' or 'YYYY-Www'
    summary_text    TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(period_type, period_key)
);
```

## Migrations

```
crates/rewindos-core/migrations/
├── V001__initial_schema.sql         # screenshots, ocr_fts, ocr_text_content, ocr_bounding_boxes, daemon_state
├── V002__vector_embeddings.sql      # embedding_status column + ocr_embeddings vec0 table
├── V003__daily_summaries.sql        # daily_summaries table
├── V004__bookmarks_collections.sql  # bookmarks, collections, collection_items
├── V005__journal.sql                # journal_entries, journal_screenshots
└── V006__journal_upgrade.sql        # mood/energy/word_count, tags, FTS, templates, summaries
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
