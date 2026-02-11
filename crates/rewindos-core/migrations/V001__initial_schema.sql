-- screenshots: primary table storing metadata for each captured frame
CREATE TABLE screenshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       INTEGER NOT NULL,
    timestamp_ms    INTEGER NOT NULL,
    app_name        TEXT,
    window_title    TEXT,
    window_class    TEXT,
    file_path       TEXT NOT NULL,
    thumbnail_path  TEXT,
    width           INTEGER NOT NULL,
    height          INTEGER NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    perceptual_hash BLOB NOT NULL,
    ocr_status      TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_screenshots_timestamp ON screenshots(timestamp);
CREATE INDEX idx_screenshots_app_name ON screenshots(app_name);
CREATE INDEX idx_screenshots_window_class ON screenshots(window_class);
CREATE INDEX idx_screenshots_ocr_status ON screenshots(ocr_status);
CREATE INDEX idx_screenshots_hash ON screenshots(perceptual_hash);

-- ocr_text_content: stores OCR text with link to screenshot
CREATE TABLE ocr_text_content (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    screenshot_id   INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
    text_content    TEXT NOT NULL,
    word_count      INTEGER NOT NULL DEFAULT 0,
    UNIQUE(screenshot_id)
);

CREATE INDEX idx_ocr_screenshot ON ocr_text_content(screenshot_id);

-- ocr_fts: standalone FTS5 virtual table for full-text search
-- Uses its own internal storage (no external content, no triggers needed).
-- screenshot_id is stored as an unindexed column for joining back.
CREATE VIRTUAL TABLE ocr_fts USING fts5(
    text_content,
    screenshot_id UNINDEXED,
    tokenize='unicode61 remove_diacritics 2'
);

-- ocr_bounding_boxes: individual text regions with coordinates
CREATE TABLE ocr_bounding_boxes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    screenshot_id   INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
    text_content    TEXT NOT NULL,
    x               INTEGER NOT NULL,
    y               INTEGER NOT NULL,
    width           INTEGER NOT NULL,
    height          INTEGER NOT NULL,
    confidence      REAL
);

CREATE INDEX idx_bbox_screenshot ON ocr_bounding_boxes(screenshot_id);

-- app_sessions: tracks contiguous usage of applications
CREATE TABLE app_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    app_name        TEXT NOT NULL,
    window_class    TEXT,
    start_time      INTEGER NOT NULL,
    end_time        INTEGER,
    duration_secs   INTEGER GENERATED ALWAYS AS (
                        CASE WHEN end_time IS NOT NULL
                        THEN end_time - start_time
                        ELSE NULL END
                    ) STORED
);

CREATE INDEX idx_sessions_app ON app_sessions(app_name);
CREATE INDEX idx_sessions_time ON app_sessions(start_time, end_time);

-- daemon_state: persistent daemon state (survives restarts)
CREATE TABLE daemon_state (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
