//! MCP tool implementations — pure functions over `Database`.
//!
//! Each tool is a thin wrapper around existing DB methods that returns
//! JSON-serializable summary structs. `rewindos-daemon` wires these into
//! the rmcp stdio server; keeping them here means they're testable
//! without the MCP protocol.

use crate::db::Database;
use crate::schema::SearchFilters;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct SearchScreenshotsInput {
    /// Search query (free text, matched against OCR content).
    pub query: String,
    /// Unix timestamp (seconds) — start of the time window, inclusive.
    pub start_time: Option<i64>,
    /// Unix timestamp (seconds) — end of the time window, inclusive.
    pub end_time: Option<i64>,
    /// Restrict to screenshots from this app name (exact match).
    pub app_filter: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    20
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ScreenshotSummary {
    pub id: i64,
    pub timestamp: i64,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub ocr_snippet: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GetTimelineInput {
    /// Start of window, unix seconds, inclusive.
    pub start_time: i64,
    /// End of window, unix seconds, inclusive.
    pub end_time: i64,
    /// Restrict to one app name (exact match).
    pub app_filter: Option<String>,
    #[serde(default = "default_timeline_limit")]
    pub limit: i64,
}

fn default_timeline_limit() -> i64 {
    100
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TimelineEntry {
    pub id: i64,
    pub timestamp: i64,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub ocr_snippet: String,
}

pub fn get_timeline(
    db: &Database,
    input: GetTimelineInput,
) -> crate::error::Result<Vec<TimelineEntry>> {
    let sessions =
        db.get_ocr_sessions_with_ids(input.start_time, input.end_time, input.limit)?;
    Ok(sessions
        .into_iter()
        .filter(|(_, app, _, _, _, _)| match &input.app_filter {
            Some(f) => app.as_deref() == Some(f.as_str()),
            None => true,
        })
        .map(
            |(id, app_name, window_title, timestamp, _file_path, ocr_text)| TimelineEntry {
                id,
                timestamp,
                app_name,
                window_title,
                ocr_snippet: truncate_chars(&ocr_text, 300),
            },
        )
        .collect())
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GetAppUsageInput {
    /// Start of window, unix seconds, inclusive.
    pub start_time: i64,
    /// End of window, unix seconds, inclusive.
    pub end_time: i64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AppUsage {
    pub app_name: String,
    pub minutes: f64,
    pub screenshot_count: i64,
}

pub fn get_app_usage(
    db: &Database,
    input: GetAppUsageInput,
    capture_interval_seconds: u32,
) -> crate::error::Result<Vec<AppUsage>> {
    let stats = db.get_app_usage_stats(input.start_time, Some(input.end_time))?;
    let seconds = capture_interval_seconds as f64;
    Ok(stats
        .into_iter()
        .map(|s| AppUsage {
            app_name: s.app_name,
            minutes: s.screenshot_count as f64 * seconds / 60.0,
            screenshot_count: s.screenshot_count,
        })
        .collect())
}

pub fn search_screenshots(
    db: &Database,
    input: SearchScreenshotsInput,
) -> crate::error::Result<Vec<ScreenshotSummary>> {
    let filters = SearchFilters {
        query: input.query,
        start_time: input.start_time,
        end_time: input.end_time,
        app_name: input.app_filter,
        limit: input.limit,
        offset: 0,
    };
    let response = db.search(&filters)?;
    Ok(response
        .results
        .into_iter()
        .map(|r| ScreenshotSummary {
            id: r.id,
            timestamp: r.timestamp,
            app_name: r.app_name,
            window_title: r.window_title,
            ocr_snippet: truncate_chars(&r.matched_text, 400),
        })
        .collect())
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        s.chars().take(max).collect::<String>() + "..."
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::NewScreenshot;

    fn seed_screenshot(db: &Database, app: &str, title: &str, ocr: &str, ts: i64) -> i64 {
        let id = db
            .insert_screenshot(&NewScreenshot {
                timestamp: ts,
                timestamp_ms: ts * 1000,
                app_name: Some(app.to_string()),
                window_title: Some(title.to_string()),
                window_class: None,
                file_path: format!("/tmp/{ts}.webp"),
                thumbnail_path: None,
                width: 1920,
                height: 1080,
                file_size_bytes: 100,
                perceptual_hash: vec![0u8; 8],
            })
            .unwrap();
        db.insert_ocr_text(id, ocr, ocr.split_whitespace().count() as i32)
            .unwrap();
        id
    }

    #[test]
    fn search_returns_matching_screenshots() {
        let db = Database::open_in_memory().unwrap();
        let id = seed_screenshot(&db, "firefox", "GitHub", "rust async patterns", 1_700_000_000);
        seed_screenshot(&db, "code", "main.py", "def foo(): pass", 1_700_000_100);

        let results = search_screenshots(
            &db,
            SearchScreenshotsInput {
                query: "rust".to_string(),
                start_time: None,
                end_time: None,
                app_filter: None,
                limit: 10,
            },
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, id);
        assert!(results[0].ocr_snippet.contains("rust"));
    }

    #[test]
    fn app_usage_aggregates_by_app() {
        let db = Database::open_in_memory().unwrap();
        seed_screenshot(&db, "firefox", "A", "window text a", 1_700_000_000);
        seed_screenshot(&db, "firefox", "B", "window text b", 1_700_000_030);
        seed_screenshot(&db, "code", "C", "window text c", 1_700_000_060);

        let usage = get_app_usage(
            &db,
            GetAppUsageInput {
                start_time: 0,
                end_time: 2_000_000_000,
            },
            5,
        )
        .unwrap();

        let firefox = usage.iter().find(|u| u.app_name == "firefox").unwrap();
        assert_eq!(firefox.screenshot_count, 2);
        assert!((firefox.minutes - (2.0 * 5.0 / 60.0)).abs() < 0.001);
    }

    #[test]
    fn timeline_returns_ordered_entries() {
        let db = Database::open_in_memory().unwrap();
        // OCR text must be >10 chars to pass get_ocr_sessions_with_ids's filter
        seed_screenshot(&db, "firefox", "A", "early window text", 1_700_000_000);
        seed_screenshot(&db, "code", "B", "middle window text", 1_700_000_500);
        seed_screenshot(&db, "slack", "C", "late window text", 1_700_001_000);

        let entries = get_timeline(
            &db,
            GetTimelineInput {
                start_time: 1_700_000_000,
                end_time: 1_700_001_500,
                app_filter: None,
                limit: 10,
            },
        )
        .unwrap();

        assert_eq!(entries.len(), 3);
        assert!(entries[0].timestamp <= entries[1].timestamp);
        assert!(entries[1].timestamp <= entries[2].timestamp);
    }

    #[test]
    fn timeline_filters_by_app() {
        let db = Database::open_in_memory().unwrap();
        seed_screenshot(&db, "firefox", "A", "firefox window text", 1_700_000_000);
        seed_screenshot(&db, "code", "B", "code window text", 1_700_000_500);

        let entries = get_timeline(
            &db,
            GetTimelineInput {
                start_time: 0,
                end_time: 2_000_000_000,
                app_filter: Some("code".to_string()),
                limit: 10,
            },
        )
        .unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].app_name.as_deref(), Some("code"));
    }

    #[test]
    fn search_filters_by_app() {
        let db = Database::open_in_memory().unwrap();
        seed_screenshot(&db, "firefox", "A", "common word", 1_700_000_000);
        let id = seed_screenshot(&db, "code", "B", "common word", 1_700_000_100);

        let results = search_screenshots(
            &db,
            SearchScreenshotsInput {
                query: "common".to_string(),
                start_time: None,
                end_time: None,
                app_filter: Some("code".to_string()),
                limit: 10,
            },
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, id);
    }
}
