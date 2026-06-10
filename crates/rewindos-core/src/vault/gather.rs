use crate::db::Database;
use crate::error::Result;
use crate::schema::TranscriptSegment;
use std::collections::HashMap;
use std::path::PathBuf;

const CAPTURE_INTERVAL_SECS: i64 = 5; // matches default capture cadence

pub struct MeetingMemory {
    pub title: String,
    pub started_at: i64,
    pub duration_secs: i64,
    pub minutes: Option<String>,
    pub transcript: Vec<TranscriptSegment>,
}

pub struct MomentMemory {
    pub timestamp: i64,
    pub app_name: String,
    pub window_title: Option<String>,
    pub thumbnail_abs: Option<PathBuf>,
    pub full_res_abs: PathBuf,
}

pub struct StatsMemory {
    pub on_screen_secs: i64,
    pub peak_hour: Option<i32>,
    pub app_minutes: Vec<(String, i64)>,
    pub todos: Vec<String>,
}

pub struct DayMemory {
    pub date_key: String,
    pub journal_text: Option<String>,
    pub recap: Option<String>, // filled by caller after resolve_recap
    pub meetings: Vec<MeetingMemory>,
    pub moments: Vec<MomentMemory>,
    pub stats: StatsMemory,
}

impl DayMemory {
    pub fn is_empty(&self) -> bool {
        self.journal_text.is_none()
            && self.meetings.is_empty()
            && self.moments.is_empty()
            && self.stats.on_screen_secs == 0
            && self.stats.todos.is_empty()
    }

    pub fn for_date(
        db: &Database,
        date_key: &str,
        day_start: i64,
        day_end: i64,
        max_moments: u32,
    ) -> Result<Self> {
        // journal: extract plain text from the Tiptap JSON, preserving newlines
        // between paragraphs so the exported markdown note reads correctly.
        let journal_text = db
            .get_journal_entry(date_key)?
            .map(|e| tiptap_plain_text(&e.content))
            .filter(|t| !t.trim().is_empty());

        // meetings that started within the day
        let mut meetings = Vec::new();
        // Scans the most recent 500 meetings; backfill of very old days may miss meetings beyond that window. TODO: replace with a date-range query.
        for m in db.list_meetings(500, 0)? {
            if m.started_at >= day_start && m.started_at < day_end {
                let dur = m.ended_at.map(|e| (e - m.started_at).max(0)).unwrap_or(0);
                meetings.push(MeetingMemory {
                    title: m.title.clone().unwrap_or_else(|| "Untitled meeting".into()),
                    started_at: m.started_at,
                    duration_secs: dur,
                    minutes: m.summary.clone(),
                    transcript: db.get_meeting_segments(m.id)?,
                });
            }
        }
        meetings.sort_by_key(|m| m.started_at);

        // stats
        let activity = db.get_activity(day_start, Some(day_end))?;
        let blocks = db.get_active_blocks(day_start, day_end, CAPTURE_INTERVAL_SECS)?;
        let on_screen_secs = blocks.iter().map(|b| b.duration_secs).sum();
        let peak_hour = activity
            .hourly_activity
            .iter()
            .max_by_key(|h| h.screenshot_count)
            .filter(|h| h.screenshot_count > 0)
            .map(|h| h.hour);
        let tasks = db.get_task_breakdown(day_start, day_end, 50, CAPTURE_INTERVAL_SECS)?;
        let mut app_secs: HashMap<String, i64> = Default::default();
        for t in &tasks {
            *app_secs.entry(t.app_name.clone()).or_default() += t.estimated_seconds;
        }
        let mut app_minutes: Vec<(String, i64)> = app_secs
            .into_iter()
            .map(|(a, s)| (a, s / 60))
            .filter(|(_, m)| *m > 0)
            .collect();
        app_minutes.sort_by_key(|a| std::cmp::Reverse(a.1));
        let todos = db
            .get_open_todos(date_key, date_key)?
            .into_iter()
            .map(|t| t.text)
            .collect();

        // moments: Task 4 implements select_key_moments; stub returns empty
        let moments = select_key_moments(db, day_start, day_end, max_moments)?;

        Ok(DayMemory {
            date_key: date_key.to_string(),
            journal_text,
            recap: None,
            meetings,
            moments,
            stats: StatsMemory { on_screen_secs, peak_hour, app_minutes, todos },
        })
    }
}

/// Extract readable text from a Tiptap JSON document (recursively concatenate
/// text nodes). Unlike db::extract_plain_text (which space-joins for FTS),
/// this preserves block separation as newlines for markdown output.
pub fn tiptap_plain_text(json: &str) -> String {
    fn is_hard_break(v: &serde_json::Value) -> bool {
        v.get("type").and_then(|t| t.as_str()) == Some("hardBreak")
    }
    fn walk(v: &serde_json::Value, out: &mut String) {
        if is_hard_break(v) {
            out.push('\n');
            return;
        }
        if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
            out.push_str(t);
        }
        if let Some(arr) = v.get("content").and_then(|c| c.as_array()) {
            for (i, child) in arr.iter().enumerate() {
                walk(child, out);
                // Insert a newline between block siblings, but skip it when
                // the current child is a hardBreak (it emitted its own newline)
                // or the next sibling is a hardBreak (it will emit one).
                let next_is_hard_break =
                    arr.get(i + 1).map(is_hard_break).unwrap_or(false);
                if i + 1 < arr.len() && !is_hard_break(child) && !next_is_hard_break {
                    out.push('\n');
                }
            }
        }
    }
    let mut out = String::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
        walk(&v, &mut out);
    }
    out.trim().to_string()
}

/// Temporary stub — Task 4 replaces with context-based selection.
fn select_key_moments(
    _db: &Database,
    _day_start: i64,
    _day_end: i64,
    _max: u32,
) -> Result<Vec<MomentMemory>> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn gather_empty_day_has_no_activity() {
        let db = Database::open_in_memory().unwrap();
        let mem = DayMemory::for_date(&db, "2026-06-10", 0, 0, 6).unwrap();
        assert!(mem.is_empty());
    }

    #[test]
    fn tiptap_plain_text_preserves_paragraph_breaks() {
        let doc = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"first"}]},{"type":"paragraph","content":[{"type":"text","text":"second"}]}]}"#;
        assert_eq!(tiptap_plain_text(doc), "first\nsecond");
    }

    #[test]
    fn tiptap_plain_text_handles_hard_break() {
        let doc = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"line one"},{"type":"hardBreak"},{"type":"text","text":"line two"}]}]}"#;
        assert!(tiptap_plain_text(doc).contains("line one\nline two"));
    }

    #[test]
    fn gather_collects_journal_and_meetings() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_journal_entry(&crate::schema::UpsertJournalEntry {
            date: "2026-06-10".into(),
            content: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"shipped the export"}]}]}"#.into(),
        }).unwrap();
        let mem = DayMemory::for_date(&db, "2026-06-10", 0, 10_000_000_000, 6).unwrap();
        assert!(mem.journal_text.as_deref().unwrap_or("").contains("shipped the export"));
    }
}
