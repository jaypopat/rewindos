//! Day-recap generation shared by the Tauri app and the daemon export.
//! Three tiers: cached AI summary → generate-if-Ollama-up → non-AI digest.

use std::sync::OnceLock;

use crate::config::ChatConfig;

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
        "You are an AI assistant analyzing a user's desktop activity for the day. \
        Based on the data below, write a brief productivity summary (3-5 sentences). \
        Be specific about what the user was working on based on the window titles and screen content. \
        Mention concrete tasks, not just app names. Be encouraging but honest.\n\n\
        App usage: {app_summary_text}\n\n\
        Activity log:\n{}\n\n\
        Write a concise daily summary. Focus on what was accomplished, not just what apps were used. \
        If you can identify specific tasks (coding, writing, browsing topics), mention them.",
        context_lines.join("\n"),
    )
}

/// Compiled once at first use; avoids per-call regex construction.
static THINK_RE: OnceLock<regex_lite::Regex> = OnceLock::new();

fn think_re() -> &'static regex_lite::Regex {
    THINK_RE.get_or_init(|| {
        regex_lite::Regex::new(r"(?s)<think>.*?</think>").expect("static regex is valid")
    })
}

/// POST a prompt to Ollama's `/api/generate` and return cleaned text.
/// Ported from the Tauri app so the daemon and app share one implementation.
///
/// `base_url` is the base Ollama URL, e.g. `"http://localhost:11434"`.
/// This function appends `/api/generate` itself — callers must NOT pre-append
/// `/api/generate`.
pub async fn generate_summary_ollama(
    prompt: &str,
    base_url: &str,
    model: &str,
) -> Option<String> {
    let endpoint = format!("{}/api/generate", base_url.trim_end_matches('/'));

    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Failed to build HTTP client: {e}");
            return None;
        }
    };

    let resp = match client
        .post(&endpoint)
        .json(&serde_json::json!({
            "model": model,
            "prompt": prompt,
            "stream": false,
            "options": { "temperature": 0.7, "num_predict": 512 }
        }))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            tracing::warn!("Ollama returned {}: {}", r.status(), r.text().await.unwrap_or_default());
            return None;
        }
        Err(e) => {
            tracing::warn!("Ollama request failed: {e}");
            return None;
        }
    };

    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(e) => {
            tracing::warn!("Failed to parse Ollama response: {e}");
            return None;
        }
    };

    let raw = json["response"].as_str().unwrap_or("").trim();
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
    if let Some(generated) =
        generate_summary_ollama(prompt, &chat.ollama_url, &chat.model).await
    {
        return (generated, true);
    }
    (build_digest(digest), false)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
