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
    // The app filter must apply inside the SQL LIMIT — filtering afterwards
    // returns nothing when the first `limit` rows belong to other apps.
    let sessions = db.get_ocr_sessions_with_ids(
        input.start_time,
        input.end_time,
        input.limit.clamp(1, 500),
        input.app_filter.as_deref(),
    )?;
    Ok(sessions
        .into_iter()
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

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GetScreenshotDetailInput {
    /// Screenshot row id.
    pub screenshot_id: i64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ScreenshotDetail {
    pub id: i64,
    pub timestamp: i64,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub full_ocr_text: String,
    pub file_path: String,
}

pub fn get_screenshot_detail(
    db: &Database,
    input: GetScreenshotDetailInput,
) -> crate::error::Result<Option<ScreenshotDetail>> {
    let Some(ss) = db.get_screenshot(input.screenshot_id)? else {
        return Ok(None);
    };
    let ocr = db.get_ocr_text(input.screenshot_id)?.unwrap_or_default();
    Ok(Some(ScreenshotDetail {
        id: ss.id,
        timestamp: ss.timestamp,
        app_name: ss.app_name,
        window_title: ss.window_title,
        full_ocr_text: ocr,
        file_path: ss.file_path,
    }))
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GetRecentActivityInput {
    /// Window length in minutes from now, default 30.
    #[serde(default = "default_recent_minutes")]
    pub minutes: i64,
}

fn default_recent_minutes() -> i64 {
    30
}

pub fn get_recent_activity(
    db: &Database,
    input: GetRecentActivityInput,
    now: i64,
) -> crate::error::Result<Vec<TimelineEntry>> {
    let start = now - input.minutes * 60;
    get_timeline(
        db,
        GetTimelineInput {
            start_time: start,
            end_time: now,
            app_filter: None,
            limit: 100,
        },
    )
}

pub fn search_screenshots(
    db: &Database,
    input: SearchScreenshotsInput,
) -> crate::error::Result<Vec<ScreenshotSummary>> {
    let query = fts5_quote(&input.query);
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let filters = SearchFilters {
        query,
        start_time: input.start_time,
        end_time: input.end_time,
        app_name: input.app_filter,
        limit: input.limit.clamp(1, 500),
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

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct SearchTranscriptsInput {
    /// Free-text query over meeting transcript segments. Omit (or pass an
    /// empty string) to list segments chronologically within the time window
    /// instead — useful for "what was discussed in yesterday's meeting?".
    #[serde(default)]
    pub query: String,
    /// Unix timestamp (seconds) — only segments spoken at/after this moment.
    pub start_time: Option<i64>,
    /// Unix timestamp (seconds) — only segments spoken at/before this moment.
    pub end_time: Option<i64>,
    #[serde(default = "default_transcript_limit")]
    pub limit: i64,
}

fn default_transcript_limit() -> i64 {
    20
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TranscriptHit {
    pub meeting_id: i64,
    pub meeting_title: Option<String>,
    /// Unix seconds the meeting started.
    pub meeting_started_at: i64,
    /// Unix seconds this segment was spoken (meeting start + offset).
    pub timestamp: i64,
    /// "You" is the user; "Remote" is the other party.
    pub speaker: String,
    pub text: String,
}

/// Search recorded meeting transcripts. With a query: FTS-ranked relevance
/// search, optionally narrowed to a time window. Without one: a chronological
/// listing of the window (defaulting to the last 7 days).
pub fn search_transcripts(
    db: &Database,
    input: SearchTranscriptsInput,
    now: i64,
) -> crate::error::Result<Vec<TranscriptHit>> {
    let limit = input.limit.clamp(1, 500);
    let query = fts5_quote(&input.query);
    if query.is_empty() {
        let start = input.start_time.unwrap_or(now - 7 * 86_400);
        let end = input.end_time.unwrap_or(now);
        let rows = db.get_transcript_segments_in_range(start, end, limit)?;
        return Ok(rows
            .into_iter()
            .map(
                |(meeting_id, title, started_at, start_ms, speaker, text)| TranscriptHit {
                    meeting_id,
                    meeting_title: title,
                    meeting_started_at: started_at,
                    timestamp: started_at + start_ms / 1000,
                    speaker,
                    text: truncate_chars(&text, 400),
                },
            )
            .collect());
    }

    // Over-fetch when a time filter applies, since relevance ranking happens
    // before the window is known. A window that excludes the 200 strongest
    // matches comes back short — acceptable for a relevance tool.
    let has_window = input.start_time.is_some() || input.end_time.is_some();
    let fetch = if has_window { 200 } else { limit };
    let hits = db.search_transcripts(&query, None, fetch)?;

    // Hits cluster in few meetings — memoize the lookups.
    let mut meetings: std::collections::HashMap<i64, Option<(Option<String>, i64)>> =
        std::collections::HashMap::new();
    let mut out = Vec::new();
    for h in hits {
        let entry = match meetings.entry(h.meeting_id) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(v) => {
                let m = db.get_meeting(h.meeting_id)?;
                v.insert(m.map(|m| (m.title, m.started_at)))
            }
        };
        // Meeting row gone (e.g. deleted mid-search): skip the orphaned
        // segment rather than fabricating epoch-zero metadata.
        let Some((title, started_at)) = entry.clone() else {
            continue;
        };
        let timestamp = started_at + h.start_ms / 1000;
        if input.start_time.is_some_and(|s| timestamp < s)
            || input.end_time.is_some_and(|e| timestamp > e)
        {
            continue;
        }
        out.push(TranscriptHit {
            meeting_id: h.meeting_id,
            meeting_title: title,
            meeting_started_at: started_at,
            timestamp,
            speaker: h.speaker_label,
            text: truncate_chars(&h.text, 400),
        });
        if out.len() as i64 >= limit {
            break;
        }
    }
    Ok(out)
}

/// Make arbitrary user text safe for FTS5 MATCH: every token is wrapped in
/// double quotes (embedded quotes escaped), so input like `he said "hi"` or
/// `crash AND burn` matches literally instead of erroring as query syntax.
/// Tokens are OR-joined: conversational LLM queries aren't boolean, and
/// requiring every token (implicit AND) would let one stray word zero out the
/// results — bm25 still ranks fuller matches first. Empty input returns "".
fn fts5_quote(raw: &str) -> String {
    raw.split_whitespace()
        .map(|tok| format!("\"{}\"", tok.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
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
    fn screenshot_detail_returns_full_ocr() {
        let db = Database::open_in_memory().unwrap();
        let id = seed_screenshot(
            &db,
            "firefox",
            "title",
            "the full OCR body that will be returned",
            1_700_000_000,
        );
        let detail = get_screenshot_detail(&db, GetScreenshotDetailInput { screenshot_id: id })
            .unwrap()
            .unwrap();
        assert_eq!(detail.id, id);
        assert_eq!(detail.full_ocr_text, "the full OCR body that will be returned");
    }

    #[test]
    fn screenshot_detail_returns_none_for_missing() {
        let db = Database::open_in_memory().unwrap();
        let detail =
            get_screenshot_detail(&db, GetScreenshotDetailInput { screenshot_id: 9999 }).unwrap();
        assert!(detail.is_none());
    }

    #[test]
    fn recent_activity_filters_by_time() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_700_000_000;
        // OCR text must be >10 chars to surface via get_ocr_sessions_with_ids
        seed_screenshot(&db, "firefox", "A", "old window text", now - 3600);
        seed_screenshot(&db, "code", "B", "new window text", now - 300);
        let entries = get_recent_activity(&db, GetRecentActivityInput { minutes: 30 }, now).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].ocr_snippet.contains("new"));
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

    fn seed_meeting(db: &Database, title: &str, started_at: i64, segments: &[(&str, i64, &str)]) -> i64 {
        let id = db.insert_meeting(started_at, Some(title), None).unwrap();
        for (speaker, start_ms, text) in segments {
            db.insert_transcript_segment(
                id,
                &crate::schema::NewTranscriptSegment {
                    start_ms: *start_ms,
                    end_ms: start_ms + 5_000,
                    source: if *speaker == "You" { "mic" } else { "system" }.to_string(),
                    speaker_label: speaker.to_string(),
                    text: text.to_string(),
                },
            )
            .unwrap();
        }
        id
    }

    #[test]
    fn transcript_search_returns_relevant_segments_with_meeting_context() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_700_100_000;
        let id = seed_meeting(
            &db,
            "Sponsor call",
            now - 3_600,
            &[
                ("You", 5_000, "let's talk about the audi sponsorship terms"),
                ("Remote", 65_000, "the budget is fine on our side"),
            ],
        );
        seed_meeting(&db, "Standup", now - 7_200, &[("You", 0, "daily sync notes")]);

        let hits = search_transcripts(
            &db,
            SearchTranscriptsInput {
                query: "sponsorship".to_string(),
                start_time: None,
                end_time: None,
                limit: 10,
            },
            now,
        )
        .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].meeting_id, id);
        assert_eq!(hits[0].meeting_title.as_deref(), Some("Sponsor call"));
        assert_eq!(hits[0].speaker, "You");
        assert_eq!(hits[0].timestamp, now - 3_600 + 5);
    }

    #[test]
    fn transcript_search_without_query_lists_the_window_chronologically() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_700_100_000;
        seed_meeting(&db, "Old", now - 30 * 86_400, &[("You", 0, "ancient history")]);
        seed_meeting(
            &db,
            "Recent",
            now - 3_600,
            &[("Remote", 10_000, "fresh discussion"), ("You", 70_000, "my reply here")],
        );

        let hits = search_transcripts(
            &db,
            SearchTranscriptsInput {
                query: "".to_string(),
                start_time: None,
                end_time: None,
                limit: 10,
            },
            now,
        )
        .unwrap();

        // Defaults to the last 7 days — the 30-day-old meeting is excluded.
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].meeting_title.as_deref(), Some("Recent"));
        assert!(hits[0].timestamp <= hits[1].timestamp);
    }

    #[test]
    fn transcript_search_applies_the_time_window_to_query_hits() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_700_100_000;
        seed_meeting(&db, "Early", now - 10 * 86_400, &[("You", 0, "pricing table talk")]);
        let recent = seed_meeting(&db, "Late", now - 3_600, &[("You", 0, "pricing table again")]);

        let hits = search_transcripts(
            &db,
            SearchTranscriptsInput {
                query: "pricing".to_string(),
                start_time: Some(now - 86_400),
                end_time: None,
                limit: 10,
            },
            now,
        )
        .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].meeting_id, recent);
    }

    #[test]
    fn search_survives_fts5_syntax_in_queries() {
        let db = Database::open_in_memory().unwrap();
        let id = seed_screenshot(&db, "firefox", "A", "he said hello to everyone", 1_700_000_000);

        // Quotes, operators, and stray syntax must match literally, not error.
        for q in [r#"he said "hello""#, "said AND hello", "hello *", "(hello"] {
            let results = search_screenshots(
                &db,
                SearchScreenshotsInput {
                    query: q.to_string(),
                    start_time: None,
                    end_time: None,
                    app_filter: None,
                    limit: 10,
                },
            )
            .unwrap();
            assert_eq!(results.first().map(|r| r.id), Some(id), "query {q:?}");
        }

        // Empty / whitespace-only queries return nothing instead of erroring.
        let empty = search_screenshots(
            &db,
            SearchScreenshotsInput {
                query: "   ".to_string(),
                start_time: None,
                end_time: None,
                app_filter: None,
                limit: 10,
            },
        )
        .unwrap();
        assert!(empty.is_empty());
    }

    #[test]
    fn timeline_app_filter_applies_inside_the_limit() {
        let db = Database::open_in_memory().unwrap();
        // 5 firefox rows first, then one slack row — with limit 5, a post-hoc
        // filter would return nothing for slack.
        for i in 0..5 {
            seed_screenshot(&db, "firefox", "A", "firefox window text", 1_700_000_000 + i * 60);
        }
        seed_screenshot(&db, "slack", "B", "slack window text", 1_700_000_400);

        let entries = get_timeline(
            &db,
            GetTimelineInput {
                start_time: 0,
                end_time: 2_000_000_000,
                app_filter: Some("slack".to_string()),
                limit: 5,
            },
        )
        .unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].app_name.as_deref(), Some("slack"));
    }

    #[test]
    fn limits_are_clamped_to_a_sane_range() {
        let db = Database::open_in_memory().unwrap();
        seed_screenshot(&db, "firefox", "A", "some window text", 1_700_000_000);

        // limit 0 / negative would otherwise return nothing or error.
        let results = search_screenshots(
            &db,
            SearchScreenshotsInput {
                query: "window".to_string(),
                start_time: None,
                end_time: None,
                app_filter: None,
                limit: 0,
            },
        )
        .unwrap();
        assert_eq!(results.len(), 1);

        let entries = get_timeline(
            &db,
            GetTimelineInput {
                start_time: 0,
                end_time: 2_000_000_000,
                app_filter: None,
                limit: -5,
            },
        )
        .unwrap();
        assert_eq!(entries.len(), 1);
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
