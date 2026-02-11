ALTER TABLE screenshots ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending';

CREATE VIRTUAL TABLE IF NOT EXISTS ocr_embeddings USING vec0(
    screenshot_id INTEGER PRIMARY KEY,
    embedding float[768]
);
