//! Day-recap generation shared by the Tauri app and the daemon export.
//! Three tiers: cached AI summary → generate-if-Ollama-up → non-AI digest.

use std::sync::OnceLock;

use crate::config::ChatConfig;
use crate::error::Result;

/// Max apps named in the OCR-recap "App usage" line.
const MAX_APPS_LISTED: usize = 15;
/// Max chars of OCR kept per session snippet in the OCR recap.
const SNIPPET_CHARS: usize = 300;
/// Max chars of joined OCR kept per app group in the OCR recap.
const GROUP_OCR_CHARS: usize = 1500;
/// Overall ceiling on the activity-log section so the prompt stays bounded
/// regardless of how long the day was.
const TOTAL_CONTEXT_CHARS: usize = 14000;

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
///
/// Field shape (`app_name`, `minutes`, `session_count`) is serialized verbatim
/// into the `daily_summaries.app_breakdown` cache JSON, so both the in-app and
/// the daemon-export writers persist identical rows.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AppEntry {
    pub app_name: String,
    /// Minutes of screen time (may be fractional, stored as f64 to match Tauri).
    pub minutes: f64,
    pub session_count: usize,
}

/// One OCR session row as returned by `Database::get_ocr_sessions`:
/// `(app_name, window_title, timestamp, ocr_text)`.
pub type OcrSession = (Option<String>, Option<String>, i64, String);

/// The OCR-derived inputs shared by the in-app History summary and the daemon
/// vault export: the app-time breakdown plus the rich prompt built from it.
#[derive(Debug, Clone)]
pub struct RichDailyInputs {
    /// App-time breakdown, sorted by minutes desc. Serializes directly into the
    /// `daily_summaries` cache.
    pub app_breakdown: Vec<AppEntry>,
    /// Sum of `session_count` across the breakdown.
    pub total_sessions: usize,
    /// The rich, OCR-backed daily prompt ready for the chat backend.
    pub prompt: String,
}

/// Compute the day's app-time breakdown and the rich OCR prompt from raw OCR
/// sessions. Single source of truth for the daily recap, called by both the
/// Tauri in-app summary and the daemon vault export so the two never diverge.
///
/// Screen time per app is estimated by walking sessions in time order: a gap to
/// the previous capture under 60s counts as real elapsed time, otherwise one
/// capture interval is assumed (mirrors the historical in-app heuristic).
pub fn build_rich_daily(sessions: &[OcrSession], capture_interval_secs: f64) -> RichDailyInputs {
    use std::collections::HashMap;

    let mut app_times: HashMap<String, (f64, usize)> = HashMap::new();
    let mut current_app: Option<String> = None;
    let mut last_ts = 0i64;

    for (app_name, _window_title, ts, _ocr) in sessions {
        let name = app_name.clone().unwrap_or_else(|| "Unknown".to_string());
        let is_same = current_app.as_deref() == Some(&name);
        let gap = ts - last_ts;

        let secs = if is_same && gap < 60 && gap > 0 {
            gap as f64
        } else {
            capture_interval_secs
        };

        let entry = app_times.entry(name.clone()).or_insert((0.0, 0));
        entry.0 += secs;
        if !is_same {
            entry.1 += 1;
        }

        current_app = Some(name);
        last_ts = *ts;
    }

    let mut app_breakdown: Vec<AppEntry> = app_times
        .into_iter()
        .map(|(app_name, (secs, count))| AppEntry {
            app_name,
            minutes: (secs / 60.0 * 10.0).round() / 10.0,
            session_count: count,
        })
        .collect();
    app_breakdown.sort_by(|a, b| {
        b.minutes
            .partial_cmp(&a.minutes)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let total_sessions = app_breakdown.iter().map(|a| a.session_count).sum();

    let session_rows: Vec<SessionRow> = sessions
        .iter()
        .map(|(app_name, window_title, _ts, ocr_text)| SessionRow {
            app_name: app_name.clone(),
            window_title: window_title.clone(),
            ocr_text: ocr_text.clone(),
        })
        .collect();
    let prompt = build_daily_prompt(&app_breakdown, &session_rows);

    RichDailyInputs {
        app_breakdown,
        total_sessions,
        prompt,
    }
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
        .take(MAX_APPS_LISTED)
        .map(|a| {
            format!(
                "{}: {:.0}min ({} sessions)",
                a.app_name, a.minutes, a.session_count
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    // --- activity context lines, grouped by consecutive app ---
    // Format one app group: up to 3 window titles plus its OCR snippets joined
    // and capped. None for an empty group.
    let format_group = |app: &str, titles: &[String], snippets: &[String]| -> Option<String> {
        if titles.is_empty() && snippets.is_empty() {
            return None;
        }
        let titles: Vec<&str> = titles.iter().take(3).map(|s| s.as_str()).collect();
        let content: String = snippets.join(" ").chars().take(GROUP_OCR_CHARS).collect();
        Some(format!(
            "- {app}: windows [{}], content: \"{}\"",
            titles.join(", "),
            content,
        ))
    };

    let mut context_lines: Vec<String> = Vec::new();
    let mut total_chars = 0usize;
    let mut current_group_app: Option<String> = None;
    let mut group_titles: Vec<String> = Vec::new();
    let mut group_ocr_snippets: Vec<String> = Vec::new();

    // Push a finished group's line, respecting the overall context budget.
    let flush = |app: &str,
                 titles: &[String],
                 snippets: &[String],
                 lines: &mut Vec<String>,
                 total: &mut usize| {
        if *total >= TOTAL_CONTEXT_CHARS {
            return;
        }
        if let Some(line) = format_group(app, titles, snippets) {
            *total += line.len();
            lines.push(line);
        }
    };

    for row in sessions {
        let name = row
            .app_name
            .clone()
            .unwrap_or_else(|| "Unknown".to_string());

        if current_group_app.as_deref() != Some(&name) {
            if let Some(prev_app) = &current_group_app {
                flush(
                    prev_app,
                    &group_titles,
                    &group_ocr_snippets,
                    &mut context_lines,
                    &mut total_chars,
                );
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
        let snippet: String = row.ocr_text.chars().take(SNIPPET_CHARS).collect();
        // Dedup consecutive near-identical captures: consecutive screenshots
        // share near-identical OCR, so skip a snippet equal to the previous one.
        if !snippet.trim().is_empty() && group_ocr_snippets.last() != Some(&snippet) {
            group_ocr_snippets.push(snippet);
        }
    }
    if let Some(prev_app) = &current_group_app {
        flush(
            prev_app,
            &group_titles,
            &group_ocr_snippets,
            &mut context_lines,
            &mut total_chars,
        );
    }

    format!(
        "{}\n\nApp usage: {app_summary_text}\n\nActivity log:\n{}\n\n{}",
        crate::prompts::RICH_DAILY_PROMPT_INTRO,
        context_lines.join("\n"),
        crate::prompts::RICH_DAILY_PROMPT_OUTRO,
    )
}

/// Compiled once at first use; avoids per-call regex construction.
static THINK_RE: OnceLock<regex_lite::Regex> = OnceLock::new();

pub(crate) fn think_re() -> &'static regex_lite::Regex {
    THINK_RE.get_or_init(|| {
        regex_lite::Regex::new(r"(?s)<think>.*?</think>").expect("static regex is valid")
    })
}

/// Clean raw LLM output: strip all closed <think>…</think> blocks, truncate at
/// any unclosed <think> (reasoning that never ended), trim. Returns None when
/// nothing usable remains.
fn clean_summary_text(raw: &str) -> Option<String> {
    let stripped = think_re().replace_all(raw, "");
    let visible = match stripped.find("<think>") {
        Some(pos) => &stripped[..pos],
        None => &stripped,
    };
    let visible = visible.trim();
    if visible.is_empty() {
        None
    } else {
        Some(visible.to_string())
    }
}

/// Generate a summary via the configured chat provider.
/// `Err` = provider/transport error (actionable: bad key, model missing, down).
/// `Ok(None)` = the model responded but produced nothing usable.
pub async fn try_generate_summary(prompt: &str, chat: &ChatConfig) -> Result<Option<String>> {
    let client = crate::chat::ChatClient::new(chat);
    let text = client.complete(prompt, 1024, 0.7).await?;
    Ok(clean_summary_text(&text))
}

/// Best-effort variant: returns None on any failure (callers fall back to the
/// digest).
pub async fn generate_summary(prompt: &str, chat: &ChatConfig) -> Option<String> {
    match try_generate_summary(prompt, chat).await {
        Ok(opt) => opt,
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
    fn clean_summary_text_strips_interior_think_blocks_after_prefix_block() {
        assert_eq!(
            clean_summary_text("<think>a</think>middle<think>b</think>end"),
            Some("middleend".to_string())
        );
    }

    #[test]
    fn clean_summary_text_truncates_at_trailing_unclosed_think() {
        assert_eq!(
            clean_summary_text("the answer <think>oops never closed"),
            Some("the answer".to_string())
        );
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
        assert!(prompt.contains("markdown"));
    }

    #[test]
    fn build_daily_prompt_uses_rich_markdown_instructions() {
        let apps = vec![AppEntry {
            app_name: "VS Code".into(),
            minutes: 60.0,
            session_count: 1,
        }];
        let sessions = vec![SessionRow {
            app_name: Some("VS Code".into()),
            window_title: Some("main.rs".into()),
            ocr_text: "fn main".into(),
        }];
        let prompt = build_daily_prompt(&apps, &sessions);
        assert!(prompt.contains("markdown"), "rich path asks for markdown: {prompt}");
        assert!(
            prompt.to_lowercase().contains("bullet"),
            "asks for bulleted tasks: {prompt}"
        );
        assert!(
            !prompt.contains("3-5 sentences"),
            "no longer the terse 3-5 sentence instruction"
        );
    }

    #[test]
    fn build_daily_prompt_dedups_consecutive_identical_ocr() {
        let apps = vec![AppEntry {
            app_name: "VS Code".into(),
            minutes: 60.0,
            session_count: 1,
        }];
        let dup = "the exact same screen content captured repeatedly";
        let sessions: Vec<SessionRow> = (0..20)
            .map(|_| SessionRow {
                app_name: Some("VS Code".into()),
                window_title: Some("main.rs".into()),
                ocr_text: dup.into(),
            })
            .collect();
        let prompt = build_daily_prompt(&apps, &sessions);
        assert_eq!(
            prompt.matches(dup).count(),
            1,
            "identical consecutive OCR should be deduped to one: {prompt}"
        );
    }

    #[test]
    fn build_daily_prompt_includes_more_than_eight_apps() {
        let apps: Vec<AppEntry> = (0..12)
            .map(|i| AppEntry {
                app_name: format!("App{i}"),
                minutes: (100 - i) as f64,
                session_count: 1,
            })
            .collect();
        let prompt = build_daily_prompt(&apps, &[]);
        assert!(prompt.contains("App8"), "9th app should be listed: {prompt}");
        assert!(prompt.contains("App11"), "12th app should be listed: {prompt}");
    }

    #[test]
    fn build_daily_prompt_caps_total_context() {
        let apps: Vec<AppEntry> = (0..30)
            .map(|i| AppEntry {
                app_name: format!("App{i}"),
                minutes: 10.0,
                session_count: 1,
            })
            .collect();
        let big = "x".repeat(5000);
        let sessions: Vec<SessionRow> = (0..30)
            .map(|i| SessionRow {
                app_name: Some(format!("App{i}")),
                window_title: Some("w".into()),
                ocr_text: big.clone(),
            })
            .collect();
        let prompt = build_daily_prompt(&apps, &sessions);
        assert!(
            prompt.len() < 20000,
            "context should be capped, got {} chars",
            prompt.len()
        );
    }

    #[test]
    fn build_rich_daily_breaks_down_apps_and_builds_rich_prompt() {
        // Three captures: two consecutive VS Code (gap 30s counts as real time),
        // then one Slack (new group → counts the interval).
        let sessions: Vec<OcrSession> = vec![
            (Some("VS Code".into()), Some("main.rs".into()), 1000, "fn main() {}".into()),
            (Some("VS Code".into()), Some("main.rs".into()), 1030, "fn main() {}".into()),
            (Some("Slack".into()), Some("#general".into()), 2000, "hello team".into()),
        ];
        let rich = build_rich_daily(&sessions, 5.0);

        // VS Code: first capture = 5s interval, second = 30s real gap → 35s.
        let vscode = rich
            .app_breakdown
            .iter()
            .find(|a| a.app_name == "VS Code")
            .expect("VS Code present");
        assert_eq!(vscode.session_count, 1, "one consecutive group");
        assert!((vscode.minutes - (35.0_f64 / 60.0 * 10.0).round() / 10.0).abs() < 1e-9);

        // Rich prompt carries OCR content + window titles, not just app names.
        assert!(rich.prompt.contains("markdown"));
        assert!(rich.prompt.contains("main.rs"));
        assert!(rich.prompt.contains("hello team"));
        assert_eq!(rich.total_sessions, 2, "VS Code group + Slack group");
    }

    #[test]
    fn build_rich_daily_breakdown_serializes_to_cache_shape() {
        let sessions: Vec<OcrSession> =
            vec![(Some("Zed".into()), None, 0, "some code on screen".into())];
        let rich = build_rich_daily(&sessions, 6.0);
        let json = serde_json::to_string(&rich.app_breakdown).unwrap();
        // Must match the daily_summaries.app_breakdown JSON contract.
        assert!(json.contains("\"app_name\":\"Zed\""));
        assert!(json.contains("\"minutes\":"));
        assert!(json.contains("\"session_count\":"));
    }

    #[test]
    fn build_rich_daily_handles_empty_sessions() {
        let rich = build_rich_daily(&[], 5.0);
        assert!(rich.app_breakdown.is_empty());
        assert_eq!(rich.total_sessions, 0);
    }
}
