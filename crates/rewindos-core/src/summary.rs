//! Day-recap generation shared by the Tauri app and the daemon export.
//! Three tiers: cached AI summary → generate-if-Ollama-up → non-AI digest.

use std::sync::OnceLock;

use crate::config::ChatConfig;
use crate::vault::gather::DayMemory;

/// Shared instruction header for the daily-summary prompts. Wording matches the
/// prompt historically assembled in `get_daily_summary` in `src-tauri/src/lib.rs`.
const DAILY_PROMPT_INTRO: &str = "You are an AI assistant analyzing a user's desktop activity for the day. \
    Based on the data below, write a brief productivity summary (3-5 sentences). \
    Be specific about what the user was working on based on the window titles and screen content. \
    Mention concrete tasks, not just app names. Be encouraging but honest.";

/// Shared closing instruction for the daily-summary prompts.
const DAILY_PROMPT_OUTRO: &str = "Write a concise daily summary. Focus on what was accomplished, not just what apps were used. \
    If you can identify specific tasks (coding, writing, browsing topics), mention them.";

/// Structured inputs for the deterministic, no-LLM fallback digest.
#[derive(Debug, Clone)]
pub struct DigestInput {
    pub on_screen_secs: i64,
    pub peak_hour: Option<i32>,
    /// (app_name, minutes) sorted desc, already truncated to a few.
    pub app_minutes: Vec<(String, i64)>,
    pub meeting_count: usize,
}

/// Deterministic one-paragraph recap from structured data. Never empty.
pub fn build_digest(input: &DigestInput) -> String {
    let h = input.on_screen_secs / 3600;
    let m = (input.on_screen_secs % 3600) / 60;
    let time = if h > 0 { format!("{h}h{m:02}m") } else { format!("{m}m") };
    let apps = input
        .app_minutes
        .iter()
        .take(3)
        .map(|(name, mins)| {
            let ah = mins / 60;
            let am = mins % 60;
            if ah > 0 {
                format!("{name} {ah}h{am:02}m")
            } else {
                format!("{name} {am}m")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let mut out = format!("{time} on screen");
    if let Some(peak) = input.peak_hour {
        out.push_str(&format!(" · busiest {peak:02}:00"));
    }
    if !apps.is_empty() {
        out.push_str(&format!(" — {apps}"));
    }
    if input.meeting_count > 0 {
        out.push_str(&format!(
            " · {} meeting{}",
            input.meeting_count,
            if input.meeting_count == 1 { "" } else { "s" }
        ));
    }
    out
}

/// A single app entry used when building the daily prompt.
#[derive(Debug, Clone)]
pub struct AppEntry {
    pub app_name: String,
    /// Minutes of screen time (may be fractional, stored as f64 to match Tauri).
    pub minutes: f64,
    pub session_count: usize,
}

/// A single OCR session row as required for prompt context grouping.
/// Mirrors `(app_name, window_title, _ts, ocr_text)` from `get_ocr_sessions`.
#[derive(Debug, Clone)]
pub struct SessionRow {
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub ocr_text: String,
}

/// Build the Ollama prompt for the daily summary.
///
/// Mirrors the prompt assembled in `get_daily_summary` in `src-tauri/src/lib.rs`
/// exactly — wording and structure are identical. Parameters carry the already-
/// computed data so this function is pure and requires no DB access.
///
/// - `app_breakdown`: top apps sorted by time desc (same slice as passed to the
///   Tauri formatter: name, minutes as f64, session_count).
/// - `sessions`: raw OCR session rows in chronological order (same rows fed to
///   the context-grouping loop in the Tauri code).
pub fn build_daily_prompt(app_breakdown: &[AppEntry], sessions: &[SessionRow]) -> String {
    // --- app summary line ---
    let app_summary_text = app_breakdown
        .iter()
        .take(8)
        .map(|a| {
            format!(
                "{}: {:.0}min ({} sessions)",
                a.app_name, a.minutes, a.session_count
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    // --- activity context lines (grouped by app, identical logic to Tauri) ---
    let mut context_lines: Vec<String> = Vec::new();
    let mut current_group_app: Option<String> = None;
    let mut group_titles: Vec<String> = Vec::new();
    let mut group_ocr_snippets: Vec<String> = Vec::new();

    for row in sessions {
        let name = row
            .app_name
            .clone()
            .unwrap_or_else(|| "Unknown".to_string());

        if current_group_app.as_deref() != Some(&name) {
            if let Some(prev_app) = &current_group_app {
                let titles: Vec<&str> = group_titles.iter().take(3).map(|s| s.as_str()).collect();
                let snippet = group_ocr_snippets
                    .join(" ")
                    .chars()
                    .take(200)
                    .collect::<String>();
                context_lines.push(format!(
                    "- {prev_app}: windows [{}], content: \"{}\"",
                    titles.join(", "),
                    snippet,
                ));
            }
            current_group_app = Some(name);
            group_titles.clear();
            group_ocr_snippets.clear();
        }

        if let Some(title) = &row.window_title {
            if !title.is_empty() && !group_titles.contains(title) {
                group_titles.push(title.clone());
            }
        }
        let snippet: String = row.ocr_text.chars().take(100).collect();
        if !snippet.trim().is_empty() {
            group_ocr_snippets.push(snippet);
        }
    }
    if let Some(prev_app) = &current_group_app {
        let titles: Vec<&str> = group_titles.iter().take(3).map(|s| s.as_str()).collect();
        let snippet = group_ocr_snippets
            .join(" ")
            .chars()
            .take(200)
            .collect::<String>();
        context_lines.push(format!(
            "- {prev_app}: windows [{}], content: \"{}\"",
            titles.join(", "),
            snippet,
        ));
    }

    // --- prompt (wording identical to src-tauri) ---
    format!(
        "{DAILY_PROMPT_INTRO}\n\nApp usage: {app_summary_text}\n\nActivity log:\n{}\n\n{DAILY_PROMPT_OUTRO}",
        context_lines.join("\n"),
    )
}

/// Build the day-recap LLM prompt from an already-gathered [`DayMemory`].
///
/// Used by the daemon's vault export, where the data section comes from the
/// memory's stats (on-screen time, peak hour, top apps), meetings, and open
/// todos. `DayMemory` does not carry OCR sessions, so unlike
/// [`build_daily_prompt`] there is no per-session activity log — the
/// instruction wording is shared verbatim.
pub fn build_daily_prompt_from_memory(mem: &DayMemory) -> String {
    let stats = &mem.stats;
    let mut data_lines: Vec<String> = Vec::new();

    let h = stats.on_screen_secs / 3600;
    let m = (stats.on_screen_secs % 3600) / 60;
    data_lines.push(format!("- On-screen time: {h}h{m:02}m"));

    if let Some(peak) = stats.peak_hour {
        data_lines.push(format!("- Busiest hour: {peak:02}:00"));
    }

    if !stats.app_minutes.is_empty() {
        let apps = stats
            .app_minutes
            .iter()
            .take(8)
            .map(|(name, mins)| format!("{name}: {mins}min"))
            .collect::<Vec<_>>()
            .join(", ");
        data_lines.push(format!("- App usage: {apps}"));
    }

    if !mem.meetings.is_empty() {
        let meetings = mem
            .meetings
            .iter()
            .map(|mt| format!("{} ({}min)", mt.title, mt.duration_secs / 60))
            .collect::<Vec<_>>()
            .join(", ");
        data_lines.push(format!("- Meetings: {meetings}"));
    }

    if !stats.todos.is_empty() {
        data_lines.push(format!("- Open todos: {}", stats.todos.len()));
    }

    format!(
        "{DAILY_PROMPT_INTRO}\n\nActivity data:\n{}\n\n{DAILY_PROMPT_OUTRO}",
        data_lines.join("\n"),
    )
}

/// Compiled once at first use; avoids per-call regex construction.
static THINK_RE: OnceLock<regex_lite::Regex> = OnceLock::new();

fn think_re() -> &'static regex_lite::Regex {
    THINK_RE.get_or_init(|| {
        regex_lite::Regex::new(r"(?s)<think>.*?</think>").expect("static regex is valid")
    })
}

/// Clean raw LLM output: trim, strip `<think>` blocks (an unclosed `<think>`
/// discards the entire response). Returns `None` when nothing usable remains.
fn clean_summary_text(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    // Strip <think>...</think> blocks emitted by reasoning models.
    // An unclosed <think> tag (no </think>) discards the entire response —
    // there is no usable text to return.
    let cleaned = if let Some(after) = raw.strip_prefix("<think>") {
        after
            .find("</think>")
            .map(|end| after[end + 8..].trim())
            .unwrap_or("")
            .to_string()
    } else {
        think_re().replace_all(raw, "").trim().to_string()
    };
    if cleaned.is_empty() {
        return None;
    }
    Some(cleaned)
}

/// Generate a summary via the configured chat provider. Returns `None` on any
/// failure (graceful degradation — callers fall back to the digest).
pub async fn generate_summary(prompt: &str, chat: &ChatConfig) -> Option<String> {
    let client = crate::chat::ChatClient::new(chat);
    match client.complete(prompt, 512, 0.7).await {
        Ok(text) => clean_summary_text(&text),
        Err(e) => {
            tracing::warn!("summary generation failed: {e}");
            None
        }
    }
}

/// Resolve the recap for a date. Tier (a) cached → (b) generate+return (caller
/// caches) → (c) deterministic digest. Returns `(text, is_ai)` — `is_ai=false`
/// means the digest tier, so the caller knows the day can be upgraded later.
///
/// A cached value is always reported as `is_ai=true`; callers must only cache
/// AI-generated recaps (never the digest), otherwise a digest day would be
/// reported as non-upgradeable.
pub async fn resolve_recap(
    cached: Option<String>,
    chat: &ChatConfig,
    prompt: &str,
    digest: &DigestInput,
) -> (String, bool) {
    if let Some(c) = cached {
        if !c.trim().is_empty() {
            return (c, true);
        }
    }
    if let Some(generated) = generate_summary(prompt, chat).await {
        return (generated, true);
    }
    (build_digest(digest), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_summary_text_passes_plain_text_trimmed() {
        assert_eq!(clean_summary_text("  a fine summary \n"), Some("a fine summary".to_string()));
    }

    #[test]
    fn clean_summary_text_strips_closed_think_block() {
        assert_eq!(
            clean_summary_text("<think>reasoning</think>the answer"),
            Some("the answer".to_string())
        );
    }

    #[test]
    fn clean_summary_text_discards_unclosed_think() {
        assert_eq!(clean_summary_text("<think>never closed..."), None);
    }

    #[test]
    fn clean_summary_text_rejects_empty() {
        assert_eq!(clean_summary_text(""), None);
        assert_eq!(clean_summary_text("   \n  "), None);
        assert_eq!(clean_summary_text("<think>x</think>   "), None);
    }

    #[test]
    fn digest_is_never_empty_and_mentions_time() {
        let input = DigestInput {
            on_screen_secs: 4 * 3600 + 12 * 60,
            peak_hour: Some(14),
            app_minutes: vec![("VS Code".into(), 120), ("Slack".into(), 60)],
            meeting_count: 2,
        };
        let d = build_digest(&input);
        assert!(!d.is_empty());
        assert!(d.contains("4h"), "should mention hours: {d}");
        assert!(d.contains("VS Code"));
        assert!(d.contains("2 meeting"));
    }

    #[test]
    fn digest_zero_data_returns_zero_minutes() {
        let input = DigestInput {
            on_screen_secs: 0,
            peak_hour: None,
            app_minutes: vec![],
            meeting_count: 0,
        };
        let d = build_digest(&input);
        assert_eq!(d, "0m on screen");
    }

    #[test]
    fn app_minutes_under_one_hour_omits_hours() {
        let input = DigestInput {
            on_screen_secs: 3600,
            peak_hour: None,
            app_minutes: vec![("Firefox".into(), 45)],
            meeting_count: 0,
        };
        let d = build_digest(&input);
        assert!(d.contains("Firefox 45m"), "expected '45m', got: {d}");
        assert!(!d.contains("0h"), "should not contain '0h': {d}");
    }

    #[test]
    fn build_daily_prompt_contains_app_and_activity() {
        let apps = vec![
            AppEntry {
                app_name: "VS Code".into(),
                minutes: 120.0,
                session_count: 3,
            },
            AppEntry {
                app_name: "Slack".into(),
                minutes: 30.0,
                session_count: 5,
            },
        ];
        let sessions = vec![
            SessionRow {
                app_name: Some("VS Code".into()),
                window_title: Some("main.rs".into()),
                ocr_text: "fn main() {}".into(),
            },
            SessionRow {
                app_name: Some("Slack".into()),
                window_title: Some("#general".into()),
                ocr_text: "hello team".into(),
            },
        ];
        let prompt = build_daily_prompt(&apps, &sessions);
        assert!(prompt.contains("VS Code: 120min (3 sessions)"));
        assert!(prompt.contains("Slack: 30min (5 sessions)"));
        assert!(prompt.contains("main.rs"));
        assert!(prompt.contains("productivity summary"));
    }

    #[test]
    fn build_daily_prompt_from_memory_contains_stats_and_meetings() {
        use crate::vault::gather::{MeetingMemory, StatsMemory};

        let mem = DayMemory {
            date_key: "2026-06-10".into(),
            journal_text: None,
            recap: None,
            meetings: vec![MeetingMemory {
                title: "Standup".into(),
                started_at: 0,
                duration_secs: 15 * 60,
                minutes: None,
                transcript: vec![],
            }],
            moments: vec![],
            stats: StatsMemory {
                on_screen_secs: 4 * 3600 + 12 * 60,
                peak_hour: Some(14),
                app_minutes: vec![("VS Code".into(), 120), ("Slack".into(), 30)],
                todos: vec!["ship the export".into()],
            },
        };
        let prompt = build_daily_prompt_from_memory(&mem);
        assert!(prompt.contains("productivity summary"), "shares the instruction wording");
        assert!(prompt.contains("On-screen time: 4h12m"));
        assert!(prompt.contains("Busiest hour: 14:00"));
        assert!(prompt.contains("VS Code: 120min"));
        assert!(prompt.contains("Standup (15min)"));
        assert!(prompt.contains("Open todos: 1"));
        assert!(prompt.contains("concise daily summary"), "shares the closing instruction");
    }
}
