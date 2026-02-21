-- Bookmarks: star individual screenshots with an optional note
CREATE TABLE bookmarks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    screenshot_id INTEGER NOT NULL UNIQUE
                  REFERENCES screenshots(id) ON DELETE CASCADE,
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_bookmarks_screenshot_id ON bookmarks(screenshot_id);
CREATE INDEX idx_bookmarks_created_at    ON bookmarks(created_at);

-- Collections: named groups (time-range, manual, or hybrid)
CREATE TABLE collections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    color       TEXT NOT NULL DEFAULT '#6366f1',
    start_time  INTEGER,  -- optional: unix timestamp for time-range collections
    end_time    INTEGER,  -- optional: unix timestamp for time-range collections
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Junction table for manually-added screenshots in a collection
CREATE TABLE collection_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL
                    REFERENCES collections(id) ON DELETE CASCADE,
    screenshot_id INTEGER NOT NULL
                    REFERENCES screenshots(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(collection_id, screenshot_id)
);

CREATE INDEX idx_collection_items_collection_id ON collection_items(collection_id);
CREATE INDEX idx_collection_items_screenshot_id ON collection_items(screenshot_id);
