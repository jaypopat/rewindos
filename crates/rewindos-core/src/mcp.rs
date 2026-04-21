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
