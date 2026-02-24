-- Journal entries: one per day, markdown content
CREATE TABLE journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,              -- YYYY-MM-DD, one entry per day
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Junction table linking journal entries to screenshots
CREATE TABLE journal_screenshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    screenshot_id INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
    caption TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(journal_entry_id, screenshot_id)
);

CREATE INDEX idx_journal_screenshots_entry ON journal_screenshots(journal_entry_id);
CREATE INDEX idx_journal_screenshots_screenshot ON journal_screenshots(screenshot_id);
