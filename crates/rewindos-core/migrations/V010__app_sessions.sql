-- Focused-app time, recorded independently of screenshots so usage stats keep
-- working in usage-only (private) mode. App name only: window titles are never
-- stored here. Replaces the never-written V001 table of the same name.
DROP TABLE app_sessions;

CREATE TABLE app_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    app_name    TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER NOT NULL
);

CREATE INDEX idx_app_sessions_started_at ON app_sessions(started_at);
CREATE INDEX idx_app_sessions_ended_at ON app_sessions(ended_at);

-- Backfill from screenshot history: consecutive captures of the same app with
-- at most 120s between them form one session, credited 5s past its last frame.
INSERT INTO app_sessions (app_name, started_at, ended_at)
WITH ordered AS (
    SELECT id, app_name, timestamp,
           LAG(app_name) OVER (ORDER BY timestamp, id) AS prev_app,
           LAG(timestamp) OVER (ORDER BY timestamp, id) AS prev_ts
    FROM screenshots
    WHERE app_name IS NOT NULL
),
marked AS (
    SELECT id, app_name, timestamp,
           CASE WHEN prev_app IS app_name AND timestamp - prev_ts <= 120 THEN 0 ELSE 1 END AS is_new
    FROM ordered
),
grouped AS (
    SELECT app_name, timestamp,
           SUM(is_new) OVER (ORDER BY timestamp, id ROWS UNBOUNDED PRECEDING) AS grp
    FROM marked
)
SELECT app_name, MIN(timestamp), MAX(timestamp) + 5
FROM grouped
GROUP BY grp
ORDER BY grp;
