CREATE TABLE meetings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at        INTEGER NOT NULL,
    ended_at          INTEGER,
    title             TEXT,
    app_name          TEXT,
    mic_audio_path    TEXT,
    system_audio_path TEXT,
    summary           TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE transcript_segments (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id       INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    start_ms         INTEGER NOT NULL,
    end_ms           INTEGER NOT NULL,
    source           TEXT NOT NULL,
    speaker_label    TEXT NOT NULL,
    text             TEXT NOT NULL,
    embedding_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX idx_segments_meeting ON transcript_segments(meeting_id);
CREATE INDEX idx_segments_time ON transcript_segments(start_ms);

CREATE VIRTUAL TABLE transcript_fts USING fts5(
    text,
    segment_id UNINDEXED
);

CREATE VIRTUAL TABLE transcript_embeddings USING vec0(
    segment_id INTEGER PRIMARY KEY,
    embedding  float[768]
);
