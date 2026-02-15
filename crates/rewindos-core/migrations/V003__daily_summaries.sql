CREATE TABLE daily_summaries (
    date_key         TEXT PRIMARY KEY,    -- 'YYYY-MM-DD'
    summary_text     TEXT,               -- AI text (NULL if Ollama unavailable)
    app_breakdown    TEXT NOT NULL,       -- JSON array of {app_name, minutes, session_count}
    total_sessions   INTEGER NOT NULL,
    time_range       TEXT NOT NULL,       -- 'start_ts-end_ts'
    model_name       TEXT,               -- Ollama model used
    generated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    screenshot_count INTEGER NOT NULL DEFAULT 0
);
