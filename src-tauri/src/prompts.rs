//! Claude-Code-driver-specific prompts. Composes on top of
//! `rewindos_core::prompts::CORE_SYSTEM_PROMPT` so the assistant identity has a
//! single source of truth.

use std::sync::LazyLock;

/// The MCP-tool half of the Claude system prompt — only the delta NOT already
/// covered by `CORE_SYSTEM_PROMPT` (the tool names, the meeting-transcript
/// guidance, the output-shape strictness). Rules shared with the core prompt
/// ([REF:ID], "answer directly", "be specific", "don't fabricate", the
/// no-history fallback) live in `CORE_SYSTEM_PROMPT` only, so the composed
/// prompt contains each rule exactly once.
const CLAUDE_MCP_ADDENDUM: &str = r#"You have access to the user's screen capture history via MCP tools (search_screenshots, get_timeline, get_app_usage, get_screenshot_detail, get_recent_activity, search_transcripts).

For questions about meetings, calls, or conversations, use search_transcripts — recorded meeting transcripts where "You" is the user and "Remote" is the other party. Call it without a query to list what was discussed in a time window.

No outline scaffolding. No "insight" blocks. No headers unless the answer naturally has >3 sections."#;

/// Full system prompt for the Claude Code Ask path = core identity + MCP tools.
pub static SYSTEM_PROMPT_FOR_CLAUDE: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{}\n\n{}",
        rewindos_core::prompts::CORE_SYSTEM_PROMPT,
        CLAUDE_MCP_ADDENDUM
    )
});

/// System prompt for the agentic daily-digest. Self-contained (does not reuse
/// `SYSTEM_PROMPT_FOR_CLAUDE`) so it can omit the `[REF:ID]` instruction: the
/// recap is shown as a static card and written verbatim into the exported
/// Obsidian/Logseq vault note (both share the same cache), where `[REF:ID]`
/// markers render as meaningless literal text.
pub const DAILY_DIGEST_SYSTEM_PROMPT: &str = "You are RewindOS, generating a daily activity recap from the user's screen \
capture history. Use your MCP tools (search_screenshots, get_timeline, get_app_usage, get_screenshot_detail, \
get_recent_activity, search_transcripts) to retrieve the day's activity before writing. For meetings, calls, or \
conversations use search_transcripts (recorded transcripts where \"You\" is the user and \"Remote\" is the other party).\n\n\
Output only the recap itself — no preamble, no commentary about the data, no sign-off, no horizontal-rule (---) \
separators. Write it as markdown: open directly with a 1-2 sentence narrative lead, then a bulleted list of the concrete \
tasks and threads grouped by project or topic, bolding the key task in each bullet. Name specific work (files, topics, people, \
sites) — not just app names. Keep it tight; omit anything you cannot tie to a real activity. Write plain prose and \
bullets — do NOT include [REF:ID] markers or screenshot ids; this recap is shown as a static note and exported to a \
vault file.\n\n\
If there is no relevant data, say \"I don't have enough screen history for that day.\" Do not fabricate.";

/// User message for agentic daily-digest generation.
pub fn agentic_digest_user_message(date_key: &str, start_time: i64, end_time: i64) -> String {
    format!(
        "Summarize what the user did on {date_key} (epoch second range {start_time}..{end_time}). \
         Use your tools to retrieve that day's screen activity, then write the recap."
    )
}

/// Prompt for summarizing a user's journal entries.
pub fn journal_summary_prompt(period_key: &str, period_type: &str, entries: &str) -> String {
    format!(
        "You are an AI assistant summarizing a user's journal entries. \
        Write a brief, insightful summary (3-5 sentences) covering themes, mood trends, \
        and notable events. Be specific and reference content from the entries.\n\n\
        Journal entries for {period_key} ({period_type}):\n\n{entries}\n\n\
        Write a concise summary highlighting patterns, mood trends, and key events."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_system_prompt_has_identity_and_tools() {
        let p = SYSTEM_PROMPT_FOR_CLAUDE.as_str();
        assert!(p.contains("RewindOS")); // from core base
        assert!(p.contains("search_screenshots")); // from MCP addendum
    }

    #[test]
    fn agentic_user_message_includes_date_and_range() {
        let m = agentic_digest_user_message("2026-06-23", 100, 200);
        assert!(m.contains("2026-06-23"));
        assert!(m.contains("100..200"));
    }
}
