# MCP Server + Claude Code Chat Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose RewindOS data to Claude Code via an MCP server, and route the in-app Ask view through the `claude` CLI when available, giving users multi-turn agentic retrieval over their screen history.

**Architecture:** The `rewindos-daemon` binary gains an `--mcp` mode that starts a stdio MCP server. Claude Code spawns it on demand. For the UI chat, responsibilities are split: **Rust** handles DB queries (`build_chat_context`) and Claude Code subprocess spawning (`ask_claude`, blocking); **the client** handles Ollama HTTP streaming directly via `fetch` + `ReadableStream` + `AbortController`, and React state holds session history. No Tauri events for chat — the old `ask-token`/`ask-done`/`ask-error` plumbing is removed.

**Tech Stack:** Rust (`rmcp` crate for MCP server, `tokio::process::Command` for Claude spawn), `rusqlite` (existing), React 19 + native `fetch` streaming (frontend), Tauri v2 (`invoke` only, no event plumbing for chat).

---

## Architectural Principle

Tauri commands are for things that **need** native access: DB queries, subprocess spawning, filesystem, D-Bus. HTTP calls to localhost (Ollama at `:11434`) don't need native access — the browser can do them directly. This split removes ~500 lines of IPC plumbing (event listeners, mutex-locked session maps, watch-channel cancellation, NDJSON parsers in Rust).

```
┌─────────────────────────────────────────────────────┐
│  Frontend (React/TS)                                 │
│                                                      │
│  Ask view:                                           │
│    - invoke("build_chat_context", { query })        │
│      → { context, references }                       │
│    - If Claude: invoke("ask_claude", { prompt })    │
│      → String (full response)                        │
│    - If Ollama: fetch to :11434, stream tokens      │
│      natively via ReadableStream + AbortController   │
│    - History: React useState                         │
└─────────────────────────────────────────────────────┘
                    │ invoke()
                    ▼
┌─────────────────────────────────────────────────────┐
│  Tauri (Rust)                                        │
│                                                      │
│  build_chat_context(query) → { context, refs }      │
│  ask_claude(prompt, session_id) → String            │
│  ask_claude_cancel(session_id) → ()                 │
│  claude_detect() / claude_register_mcp()            │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  rewindos-daemon --mcp (spawned by Claude Code)     │
│    MCP stdio server with 5 tools                    │
└─────────────────────────────────────────────────────┘
```

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `crates/rewindos-core/src/mcp.rs` | MCP tool implementations — thin functions over `Database` that return JSON-serializable structs. Pure, testable. |
| `crates/rewindos-daemon/src/mcp_server.rs` | MCP stdio server — wires the tools from `mcp.rs` into `rmcp`'s protocol handler. |
| `src-tauri/src/claude_code.rs` | Claude Code CLI helpers — `detect`, `register_mcp`, `ask_claude` (simple blocking spawn). |
| `src-tauri/src/chat_context.rs` | Chat context assembly — wraps the existing intent classifier and DB search logic into a single Tauri command. |
| `src/lib/ollama-chat.ts` | Client-side Ollama streaming — `chatStream(messages, signal)` using `fetch` + `ReadableStream`. |
| `src/features/settings/tabs/AITab/ClaudeCodeSection.tsx` | Settings UI section — one-click MCP registration, connection status. |

### Modified files

| Path | Change |
|---|---|
| `crates/rewindos-core/Cargo.toml` | Add `rmcp` dependency. |
| `crates/rewindos-daemon/Cargo.toml` | Add `rmcp` dependency. |
| `crates/rewindos-daemon/src/main.rs` | Add `Mcp` subcommand. |
| `src-tauri/src/lib.rs` | Register new commands, **remove** the old `ask`/`ask_cancel`/`ask_new_session`/`ask_health` commands and their state (`chat_sessions`, `ask_cancel_tokens`). |
| `src-tauri/Cargo.toml` | Add `which = "7"`. |
| `src/lib/api.ts` | Add `buildChatContext`, `askClaude`, `askClaudeCancel`, `claudeDetect`, `claudeRegisterMcp`. **Remove** `ask`, `askCancel`, `askHealth`, `askNewSession`. |
| `src/context/AskContext.tsx` | Rewrite to use client-side streaming for Ollama and `invoke` for Claude. No event listeners. |
| `src/features/ask/AskView.tsx` | Replace Ollama health from Tauri command with client-side fetch; show "claude" / "local" indicator. |
| `src/features/settings/tabs/AITab.tsx` | Render `ClaudeCodeSection`. |
| `src/lib/query-keys.ts` | Add `claudeStatus`, `ollamaHealth`. Remove `askHealth`. |

### Out of scope (deferred)

- Voice pipeline (separate plan)
- Proactive features / daily digests (P2)
- Journal AI summary generation still uses `ask` — leave the old path dead-code free by updating journal to use the new pattern (addressed in Task 14)

---

## Task 1: Add `rmcp` dependency and scaffold MCP subcommand

**Files:**
- Modify: `crates/rewindos-core/Cargo.toml`
- Modify: `crates/rewindos-daemon/Cargo.toml`
- Modify: `crates/rewindos-daemon/src/main.rs`

- [ ] **Step 1: Add `rmcp` to both crate manifests**

In `crates/rewindos-core/Cargo.toml`, add to `[dependencies]`:
```toml
rmcp = { version = "0.2", features = ["server", "transport-io"] }
```

In `crates/rewindos-daemon/Cargo.toml`, add to `[dependencies]`:
```toml
rmcp = { version = "0.2", features = ["server", "transport-io"] }
```

- [ ] **Step 2: Verify the crate resolves**

Run: `cargo check -p rewindos-core -p rewindos-daemon`
Expected: Compiles. If `rmcp` 0.2 doesn't exist, run `cargo search rmcp` and use the latest published version; feature names may differ — check `cargo doc -p rmcp --open` for the stdio server transport feature.

- [ ] **Step 3: Add `Mcp` subcommand to the daemon CLI**

In `crates/rewindos-daemon/src/main.rs`, extend the `Command` enum:

```rust
#[derive(Subcommand)]
enum Command {
    Run,
    Pause,
    Resume,
    Status,
    Backfill { #[arg(long, default_value = "50")] batch_size: usize },
    BackfillOcr { #[arg(long, default_value = "50")] batch_size: usize },
    Recompress {
        #[arg(long, default_value = "80")] quality: u8,
        #[arg(long, default_value = "1920")] max_width: u32,
        #[arg(long, default_value = "320")] thumb_width: u32,
        #[arg(long)] dry_run: bool,
    },
    /// Run as an MCP server over stdio (invoked by Claude Code).
    Mcp,
}
```

Extend the match in `main()`:

```rust
Command::Mcp => run_mcp_server().await,
```

Add a stub:

```rust
async fn run_mcp_server() -> anyhow::Result<()> {
    anyhow::bail!("MCP server not yet implemented")
}
```

- [ ] **Step 4: Verify**

Run: `cargo run -p rewindos-daemon -- mcp`
Expected: Prints "MCP server not yet implemented" and exits non-zero.

- [ ] **Step 5: Commit**

```bash
git add crates/rewindos-core/Cargo.toml crates/rewindos-daemon/Cargo.toml crates/rewindos-daemon/src/main.rs Cargo.lock
git commit -m "scaffold MCP subcommand and add rmcp dependency"
```

---

## Task 2: Implement `search_screenshots` MCP tool

**Files:**
- Create: `crates/rewindos-core/src/mcp.rs`
- Modify: `crates/rewindos-core/src/lib.rs`

- [ ] **Step 1: Export the module**

In `crates/rewindos-core/src/lib.rs`, add `pub mod mcp;` (matching the style of other modules in that file).

- [ ] **Step 2: Write the implementation + failing tests**

Create `crates/rewindos-core/src/mcp.rs`:

```rust
use crate::db::Database;
use crate::schema::SearchFilters;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchScreenshotsInput {
    pub query: String,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub app_filter: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 { 20 }

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
                file_path: format!("/tmp/{ts}.webp"),
                thumbnail_path: None,
                app_name: Some(app.to_string()),
                window_title: Some(title.to_string()),
                window_class: None,
                phash: 0,
                width: 1920,
                height: 1080,
                file_size: 100,
            })
            .unwrap();
        db.insert_ocr_text(id, ocr, ocr.split_whitespace().count() as i64).unwrap();
        id
    }

    #[test]
    fn search_returns_matching_screenshots() {
        let db = Database::open_in_memory().unwrap();
        let id = seed_screenshot(&db, "firefox", "GitHub", "rust async patterns", 1_700_000_000);
        seed_screenshot(&db, "code", "main.py", "def foo(): pass", 1_700_000_100);

        let results = search_screenshots(&db, SearchScreenshotsInput {
            query: "rust".to_string(),
            start_time: None, end_time: None, app_filter: None, limit: 10,
        }).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, id);
        assert!(results[0].ocr_snippet.contains("rust"));
    }

    #[test]
    fn search_filters_by_app() {
        let db = Database::open_in_memory().unwrap();
        seed_screenshot(&db, "firefox", "A", "common word", 1_700_000_000);
        let id = seed_screenshot(&db, "code", "B", "common word", 1_700_000_100);

        let results = search_screenshots(&db, SearchScreenshotsInput {
            query: "common".to_string(),
            start_time: None, end_time: None,
            app_filter: Some("code".to_string()), limit: 10,
        }).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, id);
    }
}
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p rewindos-core mcp::tests`
Expected: Both tests pass. If `NewScreenshot` fields differ, fix them by consulting `crates/rewindos-core/src/schema.rs`.

- [ ] **Step 4: Commit**

```bash
git add crates/rewindos-core/src/mcp.rs crates/rewindos-core/src/lib.rs
git commit -m "add search_screenshots MCP tool"
```

---

## Task 3: Implement `get_timeline` MCP tool

**Files:**
- Modify: `crates/rewindos-core/src/mcp.rs`

- [ ] **Step 1: Add implementation and tests**

Append to `crates/rewindos-core/src/mcp.rs`:

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct GetTimelineInput {
    pub start_time: i64,
    pub end_time: i64,
    pub app_filter: Option<String>,
    #[serde(default = "default_timeline_limit")]
    pub limit: i64,
}

fn default_timeline_limit() -> i64 { 100 }

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
    let sessions = db.get_ocr_sessions_with_ids(input.start_time, input.end_time, input.limit)?;
    Ok(sessions
        .into_iter()
        .filter(|(_, app, _, _, _, _)| match &input.app_filter {
            Some(f) => app.as_deref() == Some(f.as_str()),
            None => true,
        })
        .map(|(id, app_name, window_title, timestamp, _file_path, ocr_text)| TimelineEntry {
            id, timestamp, app_name, window_title,
            ocr_snippet: truncate_chars(&ocr_text, 300),
        })
        .collect())
}
```

In the `tests` module, add:

```rust
    #[test]
    fn timeline_returns_ordered_entries() {
        let db = Database::open_in_memory().unwrap();
        seed_screenshot(&db, "firefox", "A", "early", 1_700_000_000);
        seed_screenshot(&db, "code", "B", "middle", 1_700_000_500);
        seed_screenshot(&db, "slack", "C", "late", 1_700_001_000);

        let entries = get_timeline(&db, GetTimelineInput {
            start_time: 1_700_000_000, end_time: 1_700_001_500,
            app_filter: None, limit: 10,
        }).unwrap();

        assert_eq!(entries.len(), 3);
    }

    #[test]
    fn timeline_filters_by_app() {
        let db = Database::open_in_memory().unwrap();
        seed_screenshot(&db, "firefox", "A", "abc", 1_700_000_000);
        seed_screenshot(&db, "code", "B", "xyz", 1_700_000_500);

        let entries = get_timeline(&db, GetTimelineInput {
            start_time: 0, end_time: 2_000_000_000,
            app_filter: Some("code".to_string()), limit: 10,
        }).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].app_name.as_deref(), Some("code"));
    }
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p rewindos-core mcp::tests`
Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/rewindos-core/src/mcp.rs
git commit -m "add get_timeline MCP tool"
```

---

## Task 4: Implement `get_app_usage` MCP tool

**Files:**
- Modify: `crates/rewindos-core/src/mcp.rs`

- [ ] **Step 1: Add implementation and test**

Append to `crates/rewindos-core/src/mcp.rs`:

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct GetAppUsageInput {
    pub start_time: i64,
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
```

In the `tests` module, add:

```rust
    #[test]
    fn app_usage_aggregates_by_app() {
        let db = Database::open_in_memory().unwrap();
        seed_screenshot(&db, "firefox", "A", "a", 1_700_000_000);
        seed_screenshot(&db, "firefox", "B", "b", 1_700_000_030);
        seed_screenshot(&db, "code", "C", "c", 1_700_000_060);

        let usage = get_app_usage(&db, GetAppUsageInput {
            start_time: 0, end_time: 2_000_000_000,
        }, 5).unwrap();

        let firefox = usage.iter().find(|u| u.app_name == "firefox").unwrap();
        assert_eq!(firefox.screenshot_count, 2);
        assert!((firefox.minutes - (2.0 * 5.0 / 60.0)).abs() < 0.001);
    }
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p rewindos-core mcp::tests`
Expected: 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/rewindos-core/src/mcp.rs
git commit -m "add get_app_usage MCP tool"
```

---

## Task 5: Implement `get_screenshot_detail` and `get_recent_activity` MCP tools

**Files:**
- Modify: `crates/rewindos-core/src/mcp.rs`

- [ ] **Step 1: Add implementations and tests**

Append to `crates/rewindos-core/src/mcp.rs`:

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct GetScreenshotDetailInput {
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

#[derive(Debug, Serialize, Deserialize)]
pub struct GetRecentActivityInput {
    #[serde(default = "default_recent_minutes")]
    pub minutes: i64,
}

fn default_recent_minutes() -> i64 { 30 }

pub fn get_recent_activity(
    db: &Database,
    input: GetRecentActivityInput,
    now: i64,
) -> crate::error::Result<Vec<TimelineEntry>> {
    let start = now - input.minutes * 60;
    get_timeline(db, GetTimelineInput {
        start_time: start, end_time: now,
        app_filter: None, limit: 100,
    })
}
```

In the `tests` module, add:

```rust
    #[test]
    fn screenshot_detail_returns_full_ocr() {
        let db = Database::open_in_memory().unwrap();
        let id = seed_screenshot(&db, "firefox", "title", "the full OCR body", 1_700_000_000);
        let detail = get_screenshot_detail(&db, GetScreenshotDetailInput { screenshot_id: id })
            .unwrap().unwrap();
        assert_eq!(detail.id, id);
        assert_eq!(detail.full_ocr_text, "the full OCR body");
    }

    #[test]
    fn screenshot_detail_returns_none_for_missing() {
        let db = Database::open_in_memory().unwrap();
        let detail = get_screenshot_detail(&db, GetScreenshotDetailInput { screenshot_id: 9999 }).unwrap();
        assert!(detail.is_none());
    }

    #[test]
    fn recent_activity_filters_by_time() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_700_000_000;
        seed_screenshot(&db, "firefox", "A", "old", now - 3600);
        seed_screenshot(&db, "code", "B", "new", now - 300);
        let entries = get_recent_activity(&db, GetRecentActivityInput { minutes: 30 }, now).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].ocr_snippet.trim(), "new");
    }
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p rewindos-core mcp::tests`
Expected: 8 tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/rewindos-core/src/mcp.rs
git commit -m "add get_screenshot_detail and get_recent_activity MCP tools"
```

---

## Task 6: Wire MCP tools into rmcp stdio server

**Files:**
- Create: `crates/rewindos-daemon/src/mcp_server.rs`
- Modify: `crates/rewindos-daemon/src/main.rs`

**Note:** The exact `rmcp` API depends on the version resolved in Task 1. The contract to preserve: stdio transport, 5 tools registered, each accepting JSON matching `rewindos_core::mcp` input structs and returning JSON of the output structs.

- [ ] **Step 1: Add the module**

In `crates/rewindos-daemon/src/main.rs`, near the top with the other `mod` declarations, add:
```rust
mod mcp_server;
```

- [ ] **Step 2: Create the MCP server module**

Create `crates/rewindos-daemon/src/mcp_server.rs`:

```rust
use std::sync::Arc;

use rewindos_core::config::AppConfig;
use rewindos_core::db::Database;
use rewindos_core::mcp::{
    get_app_usage, get_recent_activity, get_screenshot_detail, get_timeline, search_screenshots,
    GetAppUsageInput, GetRecentActivityInput, GetScreenshotDetailInput, GetTimelineInput,
    SearchScreenshotsInput,
};

// rmcp imports — adapt to the resolved version. These match rmcp 0.2.x.
use rmcp::{
    model::{CallToolResult, Content, Tool},
    service::{RequestContext, RoleServer, Server, ServerHandler},
    transport::stdio::stdio,
    Error as McpError,
};
use serde_json::Value;

#[derive(Clone)]
pub struct RewindosMcpServer {
    db: Arc<Database>,
    capture_interval_seconds: u32,
}

impl RewindosMcpServer {
    pub fn new(db: Database, capture_interval_seconds: u32) -> Self {
        Self { db: Arc::new(db), capture_interval_seconds }
    }

    fn tool_definitions() -> Vec<Tool> {
        vec![
            Tool::new(
                "search_screenshots",
                "Full-text search over OCR'd screenshot history. Optional time/app filters.",
                serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" },
                        "start_time": { "type": ["integer", "null"] },
                        "end_time": { "type": ["integer", "null"] },
                        "app_filter": { "type": ["string", "null"] },
                        "limit": { "type": "integer", "default": 20 }
                    },
                    "required": ["query"]
                }),
            ),
            Tool::new(
                "get_timeline",
                "Chronological activity between start_time and end_time.",
                serde_json::json!({
                    "type": "object",
                    "properties": {
                        "start_time": { "type": "integer" },
                        "end_time": { "type": "integer" },
                        "app_filter": { "type": ["string", "null"] },
                        "limit": { "type": "integer", "default": 100 }
                    },
                    "required": ["start_time", "end_time"]
                }),
            ),
            Tool::new(
                "get_app_usage",
                "App usage breakdown (minutes per app) over a time range.",
                serde_json::json!({
                    "type": "object",
                    "properties": {
                        "start_time": { "type": "integer" },
                        "end_time": { "type": "integer" }
                    },
                    "required": ["start_time", "end_time"]
                }),
            ),
            Tool::new(
                "get_screenshot_detail",
                "Full OCR text and metadata for one screenshot.",
                serde_json::json!({
                    "type": "object",
                    "properties": { "screenshot_id": { "type": "integer" } },
                    "required": ["screenshot_id"]
                }),
            ),
            Tool::new(
                "get_recent_activity",
                "Timeline for the last N minutes (default 30).",
                serde_json::json!({
                    "type": "object",
                    "properties": { "minutes": { "type": "integer", "default": 30 } }
                }),
            ),
        ]
    }

    fn dispatch_tool(&self, name: &str, args: Value) -> Result<Value, String> {
        match name {
            "search_screenshots" => {
                let input: SearchScreenshotsInput = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let out = search_screenshots(&self.db, input).map_err(|e| e.to_string())?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "get_timeline" => {
                let input: GetTimelineInput = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let out = get_timeline(&self.db, input).map_err(|e| e.to_string())?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "get_app_usage" => {
                let input: GetAppUsageInput = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let out = get_app_usage(&self.db, input, self.capture_interval_seconds).map_err(|e| e.to_string())?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "get_screenshot_detail" => {
                let input: GetScreenshotDetailInput = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let out = get_screenshot_detail(&self.db, input).map_err(|e| e.to_string())?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "get_recent_activity" => {
                let input: GetRecentActivityInput = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let now = chrono::Local::now().timestamp();
                let out = get_recent_activity(&self.db, input, now).map_err(|e| e.to_string())?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            _ => Err(format!("unknown tool: {name}")),
        }
    }
}

impl ServerHandler for RewindosMcpServer {
    async fn list_tools(&self, _ctx: RequestContext<RoleServer>) -> Result<Vec<Tool>, McpError> {
        Ok(Self::tool_definitions())
    }

    async fn call_tool(
        &self,
        name: String,
        arguments: Option<Value>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let args = arguments.unwrap_or(Value::Null);
        match self.dispatch_tool(&name, args) {
            Ok(result) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::to_string(&result).unwrap_or_default(),
            )])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }
}

pub async fn run(config: AppConfig) -> anyhow::Result<()> {
    let db_path = config.db_path()?;
    let db = Database::open(&db_path)?;
    let server = RewindosMcpServer::new(db, config.capture.interval_seconds);
    let (stdin, stdout) = stdio();
    Server::new(server).serve(stdin, stdout).await?;
    Ok(())
}
```

- [ ] **Step 3: Wire into the CLI**

In `crates/rewindos-daemon/src/main.rs`, replace `run_mcp_server`:

```rust
async fn run_mcp_server() -> anyhow::Result<()> {
    // Do NOT call init_logging() — it would corrupt the stdio MCP protocol.
    let config = AppConfig::load()?;
    mcp_server::run(config).await
}
```

- [ ] **Step 4: Verify compilation**

Run: `cargo check -p rewindos-daemon`
Expected: Compiles. If rmcp's API names don't match, adapt — the shape (struct implementing a server trait + tool dispatcher) is what matters.

- [ ] **Step 5: Manual smoke test**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' | cargo run -p rewindos-daemon -- mcp
```
Expected: A JSON-RPC response on stdout with `serverInfo`.

- [ ] **Step 6: Commit**

```bash
git add crates/rewindos-daemon/src/mcp_server.rs crates/rewindos-daemon/src/main.rs
git commit -m "wire MCP tools into rmcp stdio server"
```

---

## Task 7: End-to-end test with Claude Code

**Files:** None — manual verification.

- [ ] **Step 1: Register MCP server in Claude Code settings**

Add to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "rewindos": {
      "command": "/absolute/path/to/target/debug/rewindos-daemon",
      "args": ["--mcp"]
    }
  }
}
```

Use: `realpath target/debug/rewindos-daemon`

- [ ] **Step 2: Verify tool discovery**

Run: `claude mcp list`
Expected: `rewindos` listed with its 5 tools.

- [ ] **Step 3: Invoke via Claude Code**

Run: `claude -p "Use the rewindos MCP to list activity from the last 30 minutes and summarize"`
Expected: Claude calls `get_recent_activity` and responds with a real summary (or "no data" if DB is empty).

- [ ] **Step 4: No commit** — verification checkpoint only.

---

## Task 8: `claude_detect` Tauri command

**Files:**
- Create: `src-tauri/src/claude_code.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the `which` dependency**

In `src-tauri/Cargo.toml`, add to `[dependencies]`:
```toml
which = "7"
```

- [ ] **Step 2: Create the module**

Create `src-tauri/src/claude_code.rs`:

```rust
use std::path::PathBuf;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ClaudeCodeStatus {
    pub available: bool,
    pub path: Option<String>,
    pub mcp_registered: bool,
}

pub fn detect() -> ClaudeCodeStatus {
    let path: Option<PathBuf> = which::which("claude").ok();
    let available = path.is_some();
    let mcp_registered = is_mcp_registered();
    ClaudeCodeStatus {
        available,
        path: path.map(|p| p.to_string_lossy().into_owned()),
        mcp_registered,
    }
}

fn is_mcp_registered() -> bool {
    let Some(home) = dirs::home_dir() else { return false; };
    let settings_path = home.join(".claude").join("settings.json");
    let Ok(contents) = std::fs::read_to_string(&settings_path) else { return false; };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else { return false; };
    json.get("mcpServers").and_then(|m| m.get("rewindos")).is_some()
}
```

- [ ] **Step 3: Register in lib.rs**

In `src-tauri/src/lib.rs`, near the top:
```rust
mod claude_code;
```

Add the command (alongside the other commands, e.g. after `ask_cancel` around line 683):

```rust
#[tauri::command]
fn claude_detect() -> claude_code::ClaudeCodeStatus {
    claude_code::detect()
}
```

In `invoke_handler`, add `claude_detect,` to the list.

- [ ] **Step 4: Expose in the frontend API**

In `src/lib/api.ts`, append:

```typescript
export interface ClaudeCodeStatus {
  available: boolean;
  path: string | null;
  mcp_registered: boolean;
}

export async function claudeDetect(): Promise<ClaudeCodeStatus> {
  return invoke("claude_detect");
}
```

- [ ] **Step 5: Verify**

Run `cargo check -p rewindos`, then `bun run tauri dev`. In DevTools:
```javascript
await window.__TAURI__.core.invoke("claude_detect")
```
Expected: `{available, path, mcp_registered}` object.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/claude_code.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src/lib/api.ts Cargo.lock
git commit -m "add claude_detect Tauri command"
```

---

## Task 9: `claude_register_mcp` Tauri command

**Files:**
- Modify: `src-tauri/src/claude_code.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the register function**

In `src-tauri/src/claude_code.rs`, append:

```rust
pub fn register_mcp() -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let settings_dir = home.join(".claude");
    std::fs::create_dir_all(&settings_dir).map_err(|e| format!("mkdir: {e}"))?;
    let settings_path = settings_dir.join("settings.json");

    let mut json: serde_json::Value = if settings_path.exists() {
        let contents = std::fs::read_to_string(&settings_path).map_err(|e| format!("read: {e}"))?;
        if contents.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&contents).map_err(|e| format!("parse: {e}"))?
        }
    } else {
        serde_json::json!({})
    };

    let daemon_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("rewindos-daemon")))
        .filter(|p| p.exists())
        .or_else(|| which::which("rewindos-daemon").ok())
        .ok_or_else(|| "rewindos-daemon binary not found".to_string())?;

    let entry = serde_json::json!({
        "command": daemon_path.to_string_lossy(),
        "args": ["--mcp"]
    });

    json.as_object_mut()
        .ok_or_else(|| "settings.json root must be an object".to_string())?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "mcpServers must be an object".to_string())?
        .insert("rewindos".to_string(), entry);

    let pretty = serde_json::to_string_pretty(&json).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&settings_path, pretty).map_err(|e| format!("write: {e}"))?;
    Ok(())
}
```

- [ ] **Step 2: Add the Tauri command**

In `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn claude_register_mcp() -> Result<claude_code::ClaudeCodeStatus, String> {
    claude_code::register_mcp()?;
    Ok(claude_code::detect())
}
```

Register `claude_register_mcp,` in `invoke_handler`.

- [ ] **Step 3: Expose in the frontend**

In `src/lib/api.ts`:

```typescript
export async function claudeRegisterMcp(): Promise<ClaudeCodeStatus> {
  return invoke("claude_register_mcp");
}
```

- [ ] **Step 4: Manual test**

In DevTools: `await window.__TAURI__.core.invoke("claude_register_mcp")`
Then inspect `~/.claude/settings.json` — should contain the `mcpServers.rewindos` entry.
Verify: `claude mcp list` shows `rewindos`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/claude_code.rs src-tauri/src/lib.rs src/lib/api.ts
git commit -m "add claude_register_mcp for one-click MCP setup"
```

---

## Task 10: `build_chat_context` Tauri command

Moves the existing context-building logic (currently buried inside `src-tauri/src/lib.rs` `ask` command, lines ~711-860) into a focused command. Pure function: `(query) → (context, references)`. The client calls this to get ready-to-use context, then chats with Ollama or Claude.

**Files:**
- Create: `src-tauri/src/chat_context.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Create the module**

Create `src-tauri/src/chat_context.rs`:

```rust
use rewindos_core::chat::{
    ContextAssembler, IntentCategory, IntentClassifier, OllamaChatClient, QueryConfidence,
    ScreenshotReference,
};
use rewindos_core::config::AppConfig;
use rewindos_core::db::Database;
use rewindos_core::embedding::OllamaClient as EmbeddingClient;
use rewindos_core::schema::SearchFilters;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ChatContext {
    pub context: String,
    pub references: Vec<ScreenshotReference>,
    pub intent_category: String,
}

pub async fn build(
    db: &std::sync::Mutex<Database>,
    embedding_client: Option<&EmbeddingClient>,
    config: &AppConfig,
    query: &str,
) -> Result<ChatContext, String> {
    let chat_client = OllamaChatClient::new(&config.chat);

    // Intent — LLM first, regex fallback
    let intent = match chat_client.analyze_query(query).await {
        Ok(i) => i,
        Err(_) => IntentClassifier::classify(query),
    };

    let max_context_tokens = config.chat.max_context_tokens;

    let (context, references) = match intent.category {
        IntentCategory::Recall | IntentCategory::General | IntentCategory::AppSpecific => {
            let search_query = if intent.search_terms.is_empty() {
                query.to_string()
            } else {
                intent.search_terms.join(" ")
            };

            let filters = SearchFilters {
                query: search_query.clone(),
                start_time: intent.time_range.map(|(s, _)| s),
                end_time: intent.time_range.map(|(_, e)| e),
                app_name: intent.app_filter.clone(),
                limit: 15,
                offset: 0,
            };

            // Layer 1: hybrid search if embedding client is available
            let mut search_response = None;
            if let Some(embed_client) = embedding_client {
                let embedding = embed_client.embed(&search_query).await.ok().flatten();
                if let Some(emb) = embedding {
                    let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
                    search_response = db.hybrid_search(&filters, Some(&emb)).ok();
                }
            }

            let result_count = search_response.as_ref().map(|r| r.results.len()).unwrap_or(0);

            // Layer 2: FTS5 exact
            if result_count < 3 {
                let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
                if let Ok(r) = db.search(&filters) {
                    if r.results.len() > result_count {
                        search_response = Some(r);
                    }
                }
            }

            let result_count = search_response.as_ref().map(|r| r.results.len()).unwrap_or(0);

            // Layer 3: FTS5 OR query
            if (intent.confidence == QueryConfidence::Low || result_count < 3)
                && intent.search_terms.len() > 1
            {
                let or_filters = SearchFilters {
                    query: intent.search_terms.join(" OR "),
                    ..filters.clone()
                };
                let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
                if let Ok(r) = db.search(&or_filters) {
                    if r.results.len() > result_count {
                        search_response = Some(r);
                    }
                }
            }

            let has_results = search_response.as_ref().map(|r| !r.results.is_empty()).unwrap_or(false);

            if has_results {
                let response = search_response.unwrap();
                let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
                let results: Vec<_> = response.results.iter().map(|r| {
                    let ocr = db.get_ocr_text(r.id).unwrap_or(None).unwrap_or_default();
                    (r.id, r.timestamp, r.app_name.clone(), r.window_title.clone(), r.file_path.clone(), ocr)
                }).collect();
                ContextAssembler::from_search_results_budgeted(&results, max_context_tokens)
            } else {
                // Layer 4: timeline fallback
                let now = chrono::Local::now().timestamp();
                let (start, end) = intent.time_range.unwrap_or((now - 86400, now));
                let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
                let sessions = db.get_ocr_sessions_with_ids(start, end, 80).unwrap_or_default();
                ContextAssembler::from_sessions_with_refs_budgeted(&sessions, max_context_tokens, 20)
            }
        }
        IntentCategory::TimeBased => {
            let (start, end) = intent.time_range.unwrap_or_else(|| {
                let now = chrono::Local::now().timestamp();
                (now - 86400, now)
            });
            let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
            match db.get_ocr_sessions_with_ids(start, end, 80) {
                Ok(sessions) => ContextAssembler::from_sessions_with_refs_budgeted(&sessions, max_context_tokens, 20),
                Err(_) => ("No activity data found for this time range.".to_string(), Vec::new()),
            }
        }
        IntentCategory::Productivity => {
            let (start, end) = intent.time_range.unwrap_or_else(|| {
                let now = chrono::Local::now().timestamp();
                (now - 86400, now)
            });
            let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
            let stats = db.get_app_usage_stats(start, Some(end)).unwrap_or_default();
            let sessions = db.get_ocr_sessions_with_ids(start, end, 80).unwrap_or_default();
            let secs = config.capture.interval_seconds as f64;
            let stat_tuples: Vec<_> = stats.iter().map(|s| {
                (s.app_name.clone(), s.screenshot_count as f64 * secs / 60.0, s.screenshot_count as usize)
            }).collect();
            ContextAssembler::from_app_stats(&stat_tuples, &sessions, max_context_tokens)
        }
    };

    let intent_category = match intent.category {
        IntentCategory::Recall => "recall",
        IntentCategory::TimeBased => "time_based",
        IntentCategory::Productivity => "productivity",
        IntentCategory::AppSpecific => "app_specific",
        IntentCategory::General => "general",
    }.to_string();

    Ok(ChatContext { context, references, intent_category })
}
```

- [ ] **Step 2: Add the command**

In `src-tauri/src/lib.rs`, near the top: `mod chat_context;`

Add the command:

```rust
#[tauri::command]
async fn build_chat_context(
    state: State<'_, AppState>,
    query: String,
) -> Result<chat_context::ChatContext, String> {
    let config = state.config.lock().map_err(|e| format!("config lock: {e}"))?.clone();
    chat_context::build(&state.db, state.embedding_client.as_ref(), &config, &query).await
}
```

Register `build_chat_context,` in `invoke_handler`.

- [ ] **Step 3: Expose in frontend**

In `src/lib/api.ts`:

```typescript
export interface ChatContext {
  context: string;
  references: ScreenshotRef[];
  intent_category: string;
}

export async function buildChatContext(query: string): Promise<ChatContext> {
  return invoke("build_chat_context", { query });
}
```

- [ ] **Step 4: Verify**

Run `cargo check -p rewindos`. Start the app. In DevTools:
```javascript
await window.__TAURI__.core.invoke("build_chat_context", { query: "test" })
```
Expected: `{context: "...", references: [...], intent_category: "..."}`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/chat_context.rs src-tauri/src/lib.rs src/lib/api.ts
git commit -m "add build_chat_context Tauri command"
```

---

## Task 11: `ask_claude` command (simple blocking spawn)

No streaming, no events. Spawn → wait → return. Cancellation by killing the child.

**Files:**
- Modify: `src-tauri/src/claude_code.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`

We track PIDs (not `Child` objects) in `AppState` because `Child::wait_with_output` consumes the child by value — you can't both wait and separately kill through a shared handle. PID + SIGTERM via `nix` is the clean pattern.

- [ ] **Step 1: Add `nix` dependency**

In `src-tauri/Cargo.toml`, add to `[dependencies]`:
```toml
nix = { version = "0.29", features = ["signal"] }
```

- [ ] **Step 2: Add PID tracking to AppState**

In `src-tauri/src/lib.rs`, extend `AppState`:

```rust
struct AppState {
    dbus: zbus::Connection,
    db: Mutex<Database>,
    config: Mutex<AppConfig>,
    chat_sessions: Arc<Mutex<HashMap<String, Vec<ChatMessage>>>>,
    ask_cancel_tokens: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    embedding_client: Option<EmbeddingClient>,
    claude_pids: Arc<tokio::sync::Mutex<HashMap<String, u32>>>, // NEW
}
```

(The `chat_sessions` and `ask_cancel_tokens` fields will be removed in Task 14 — leave them for now so this task compiles in isolation.)

In the `AppState` construction (inside `setup`, around line 1592), initialize:
```rust
claude_pids: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
```

- [ ] **Step 3: Add the spawn helper**

In `src-tauri/src/claude_code.rs`, append:

```rust
use std::process::Stdio;
use tokio::process::Command;

pub async fn ask_claude_spawn(prompt: &str) -> Result<tokio::process::Child, String> {
    Command::new("claude")
        .arg("-p")
        .arg(prompt)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn claude: {e}"))
}
```

- [ ] **Step 4: Add the Tauri commands**

In `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
async fn ask_claude(
    state: State<'_, AppState>,
    session_id: String,
    prompt: String,
) -> Result<String, String> {
    let child = claude_code::ask_claude_spawn(&prompt).await?;
    let pid = child.id().ok_or("no pid for claude child")?;

    // Register pid so ask_claude_cancel can find it
    {
        let mut map = state.claude_pids.lock().await;
        map.insert(session_id.clone(), pid);
    }

    let output_result = child.wait_with_output().await;

    // Always clean up the pid entry, even on error or kill
    {
        let mut map = state.claude_pids.lock().await;
        map.remove(&session_id);
    }

    let output = output_result.map_err(|e| format!("wait: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("claude exited {}: {}", output.status, stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
async fn ask_claude_cancel(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let pid = {
        let map = state.claude_pids.lock().await;
        map.get(&session_id).copied()
    };
    if let Some(pid) = pid {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
    Ok(())
}
```

Register `ask_claude,` and `ask_claude_cancel,` in `invoke_handler`.

- [ ] **Step 5: Expose in frontend**

In `src/lib/api.ts`:

```typescript
export async function askClaude(sessionId: string, prompt: string): Promise<string> {
  return invoke("ask_claude", { sessionId, prompt });
}

export async function askClaudeCancel(sessionId: string): Promise<void> {
  return invoke("ask_claude_cancel", { sessionId });
}
```

- [ ] **Step 6: Verify**

Run: `cargo check -p rewindos`
Expected: Compiles.

Start app, in DevTools:
```javascript
await window.__TAURI__.core.invoke("ask_claude", {
  sessionId: "test",
  prompt: "say hello in exactly 3 words"
})
```
Expected: Returns a string (Claude's output).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/claude_code.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src/lib/api.ts Cargo.lock
git commit -m "add ask_claude blocking spawn command with SIGTERM cancel"
```

---

## Task 12: Client-side Ollama streaming

**Files:**
- Create: `src/lib/ollama-chat.ts`

- [ ] **Step 1: Create the module**

Create `src/lib/ollama-chat.ts`:

```typescript
export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatOptions {
  baseUrl: string;
  model: string;
  temperature: number;
  messages: OllamaMessage[];
  signal: AbortSignal;
  onToken: (token: string) => void;
}

export async function ollamaChat(opts: OllamaChatOptions): Promise<string> {
  const response = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: true,
      options: { temperature: opts.temperature },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
  }

  const body = response.body;
  if (!body) throw new Error("No response body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Ollama emits NDJSON — one JSON object per line
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        try {
          const obj = JSON.parse(line);
          const token = obj?.message?.content ?? "";
          if (token) {
            full += token;
            opts.onToken(token);
          }
          if (obj?.done) return full;
        } catch {
          // Skip malformed lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return full;
}

export async function ollamaHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Smoke test in browser console**

Start the app. With Ollama running locally, in DevTools:

```javascript
const { ollamaChat } = await import("/src/lib/ollama-chat.ts");
const ctrl = new AbortController();
await ollamaChat({
  baseUrl: "http://localhost:11434",
  model: "qwen2.5:3b",
  temperature: 0.7,
  messages: [{ role: "user", content: "say hi in 3 words" }],
  signal: ctrl.signal,
  onToken: (t) => console.log(t),
});
```
Expected: Tokens log one at a time, final return is the full response.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ollama-chat.ts
git commit -m "add client-side Ollama streaming via fetch + ReadableStream"
```

---

## Task 13: Rewrite AskContext using the new architecture

The new `AskContext` holds history as plain React state, calls `buildChatContext` to get DB context, then either streams from Ollama directly or invokes `ask_claude` for the Claude path. No Tauri event listeners.

**Files:**
- Modify: `src/context/AskContext.tsx`

- [ ] **Step 1: Rewrite the provider**

Replace the entire contents of `src/context/AskContext.tsx`:

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  askClaude,
  askClaudeCancel,
  buildChatContext,
  claudeDetect,
  getConfig,
  type ScreenshotRef,
} from "@/lib/api";
import { ollamaChat, type OllamaMessage } from "@/lib/ollama-chat";

let nextMsgId = 0;

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  references?: ScreenshotRef[];
}

const SYSTEM_PROMPT = `You are RewindOS, a local AI assistant with access to the user's screen capture history. You answer questions about what the user has seen, done, and worked on — based on OCR text extracted from periodic screenshots.

## Core Rules
- Answer directly. Start with the answer, not preamble.
- When referencing a specific screenshot, use [REF:ID] format (e.g. [REF:42]).
- Be specific: mention timestamps, window titles, app names.
- Use markdown formatting.
- Never fabricate information not present in the context.
- If context has no relevant data, say "I don't have enough screen history for that time period."

## Format
- Keep answers under 300 words.
- No filler phrases like "Based on the context" or "Let me analyze".
- NEVER just rephrase the user's question.`;

interface AskContextValue {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
  cancelStream: () => void;
  newSession: () => void;
}

const AskContext = createContext<AskContextValue | null>(null);

export function AskProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-session id used only for cancelling Claude subprocess (local-only)
  const sessionIdRef = useRef<string>(crypto.randomUUID());
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (text: string) => {
      if (isStreaming || !text.trim()) return;

      setError(null);
      setIsStreaming(true);

      // Add user + empty assistant placeholder
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId++, role: "user", content: text },
        { id: nextMsgId++, role: "assistant", content: "" },
      ]);

      try {
        // 1. Get context + references from Rust
        const ctx = await buildChatContext(text);

        // 2. Update the placeholder with references
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, references: ctx.references }];
          }
          return prev;
        });

        // 3. Route based on Claude Code availability
        const claude = await claudeDetect();
        const useClaude = claude.available && claude.mcp_registered;

        if (useClaude) {
          const prompt = `${SYSTEM_PROMPT}\n\nCurrent time: ${new Date().toISOString()}\n\n${ctx.context}\n\nUser question: ${text}`;
          const response = await askClaude(sessionIdRef.current, prompt);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant") {
              return [...prev.slice(0, -1), { ...last, content: response }];
            }
            return prev;
          });
        } else {
          // Ollama path — build message history from React state
          const config = await getConfig();
          const historyMessages: OllamaMessage[] = messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .slice(-config.chat.max_history_messages)
            .map((m) => ({ role: m.role, content: m.content }));

          const ollamaMessages: OllamaMessage[] = [
            {
              role: "system",
              content: `${SYSTEM_PROMPT}\n\nCurrent time: ${new Date().toISOString()}\n\n${ctx.context}`,
            },
            ...historyMessages,
            { role: "user", content: text },
          ];

          abortRef.current = new AbortController();

          await ollamaChat({
            baseUrl: config.chat.ollama_url,
            model: config.chat.model,
            temperature: config.chat.temperature,
            messages: ollamaMessages,
            signal: abortRef.current.signal,
            onToken: (token) => {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === "assistant") {
                  return [...prev.slice(0, -1), { ...last, content: last.content + token }];
                }
                return prev;
              });
            },
          });
        }
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // Cancelled — leave partial response intact
        } else {
          setError(e instanceof Error ? e.message : String(e));
          // Remove the empty assistant placeholder
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && last.content === "") {
              return prev.slice(0, -1);
            }
            return prev;
          });
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [isStreaming, messages],
  );

  const cancelStream = useCallback(() => {
    if (!isStreaming) return;
    abortRef.current?.abort();
    askClaudeCancel(sessionIdRef.current).catch(() => {});
    setIsStreaming(false);
  }, [isStreaming]);

  const newSession = useCallback(() => {
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    abortRef.current?.abort();
    sessionIdRef.current = crypto.randomUUID();
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return (
    <AskContext.Provider value={{ messages, isStreaming, error, sendMessage, cancelStream, newSession }}>
      {children}
    </AskContext.Provider>
  );
}

export function useAskChat() {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error("useAskChat must be used within AskProvider");
  return ctx;
}
```

- [ ] **Step 2: Verify**

`bun run typecheck` (or equivalent) — expect 0 errors related to AskContext. There will be errors elsewhere referencing removed API functions (`ask`, `askCancel`, etc.) — those get fixed in Task 14.

- [ ] **Step 3: Commit**

```bash
git add src/context/AskContext.tsx
git commit -m "rewrite AskContext to use client-side streaming"
```

---

## Task 14: Remove obsolete Tauri commands and update callers

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/features/ask/AskView.tsx`
- Modify: `src/features/journal/hooks/useJournalEntry.ts`
- Modify: `src/lib/query-keys.ts`

- [ ] **Step 1: Remove `ask`, `ask_cancel`, `ask_new_session`, `ask_health` from Rust**

In `src-tauri/src/lib.rs`:
1. Delete the `ask` command function (from `#[tauri::command] async fn ask` through its closing `}`, roughly lines 685-1011).
2. Delete `ask_new_session`, `ask_health`, `ask_cancel` (lines 649-683).
3. Remove `ask,`, `ask_new_session,`, `ask_health,`, `ask_cancel,` from `invoke_handler`.
4. Remove `chat_sessions: Arc<Mutex<HashMap<String, Vec<ChatMessage>>>>` and `ask_cancel_tokens: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>` from `AppState` (and their initialization in `setup`).
5. Remove unused imports: `ChatMessage`, `ChatRole`, `ChatStreamChunk`, `ContextAssembler`, `IntentCategory`, `IntentClassifier`, `QueryConfidence`, `ScreenshotReference`, `SYSTEM_PROMPT`, `watch`, `OllamaChatClient`, `StreamExt`, `uuid` (if only used by ask_new_session). Keep `ScreenshotReference` if `chat_context::ChatContext` references it transitively — check with `cargo check`.
6. Delete the `AskResponse`, `AskTokenPayload`, `AskDonePayload`, `AskErrorPayload` structs if they exist in this file.

Run `cargo check -p rewindos` — fix any cascading errors by removing remaining ask-related code.

- [ ] **Step 2: Remove the frontend API functions**

In `src/lib/api.ts`, remove:
- `ask`
- `askCancel`
- `askHealth`
- `askNewSession`
- The `AskResponse` type and `ScreenshotRef` type if not used elsewhere (check — probably keep `ScreenshotRef` since `ChatContext` uses it).

- [ ] **Step 3: Update AskView**

In `src/features/ask/AskView.tsx`:
1. Remove the `useQuery` for `askHealth` (lines ~23-28).
2. Replace with a client-side Ollama health check + Claude detection combined:

```tsx
import { ollamaHealth } from "@/lib/ollama-chat";
import { claudeDetect, getConfig } from "@/lib/api";

// Inside AskView:
const { data: config } = useQuery({
  queryKey: queryKeys.config(),
  queryFn: getConfig,
});

const { data: ollamaOnline = false } = useQuery({
  queryKey: queryKeys.ollamaHealth(),
  queryFn: () => (config ? ollamaHealth(config.chat.ollama_url) : false),
  enabled: !!config,
  refetchInterval: 60_000,
  staleTime: 30_000,
});

const { data: claudeStatus } = useQuery({
  queryKey: queryKeys.claudeStatus(),
  queryFn: claudeDetect,
  refetchInterval: 60_000,
});

const usingClaude = claudeStatus?.available && claudeStatus.mcp_registered;
const chatReady = usingClaude || ollamaOnline;
```

3. Update the placeholder text and disabled logic to use `chatReady` / `usingClaude`:

```tsx
placeholder={
  !chatReady
    ? (usingClaude ? "claude unavailable" : "ollama is offline — start it to chat")
    : isStreaming
    ? "thinking..."
    : "ask about your screen history"
}
disabled={isStreaming || !chatReady}
```

4. Replace the status dot to reflect chatReady + mode:

```tsx
<div
  className={cn(
    "w-1.5 h-1.5 rounded-full transition-colors",
    chatReady ? "bg-signal-success" : "bg-signal-error",
  )}
  title={
    usingClaude ? "Claude Code connected"
    : ollamaOnline ? "Ollama connected"
    : "No chat backend available"
  }
/>
<span className="font-mono text-xs text-text-muted uppercase tracking-wider">ask</span>
<span
  className={cn(
    "font-mono text-[10px] uppercase tracking-wider",
    usingClaude ? "text-semantic" : "text-text-muted",
  )}
>
  · {usingClaude ? "claude" : "local"}
</span>
```

- [ ] **Step 4: Update journal hook**

In `src/features/journal/hooks/useJournalEntry.ts`, lines 14 and 119-120 reference `askHealth`. Replace with `ollamaHealth`:

```typescript
import { getConfig } from "@/lib/api";
import { ollamaHealth } from "@/lib/ollama-chat";

// Inside the hook, replace the askHealth query:
const { data: config } = useQuery({
  queryKey: queryKeys.config(),
  queryFn: getConfig,
});

const { data: /* same name */ } = useQuery({
  queryKey: queryKeys.ollamaHealth(),
  queryFn: () => (config ? ollamaHealth(config.chat.ollama_url) : false),
  enabled: !!config,
});
```

(If `getConfig` isn't already exposed in `src/lib/api.ts`, it should be — there's a `get_config` command used elsewhere. Verify via grep.)

- [ ] **Step 5: Update query keys**

In `src/lib/query-keys.ts`:
- Remove `askHealth: () => ["ask-health"] as const,`
- Add `ollamaHealth: () => ["ollama-health"] as const,`
- Add `claudeStatus: () => ["claude-status"] as const,`

Update the test file `src/lib/query-keys.test.ts` accordingly.

- [ ] **Step 6: Verify**

Run:
```bash
cargo check -p rewindos
bun run typecheck
bun run test:unit
```
Expected: All green.

Start the app: `bun run tauri dev`
- Open Ask view with Ollama running (no Claude Code): typing a question should stream tokens natively.
- Stop Ollama — header dot goes red, input disabled.
- Start Claude Code + register MCP: header shows "claude" badge, responses come through Claude.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src/lib/api.ts src/features/ask/AskView.tsx src/features/journal/hooks/useJournalEntry.ts src/lib/query-keys.ts src/lib/query-keys.test.ts
git commit -m "remove obsolete ask/ask_cancel/ask_health commands, update callers"
```

---

## Task 15: ClaudeCodeSection in Settings

**Files:**
- Create: `src/features/settings/tabs/AITab/ClaudeCodeSection.tsx`
- Modify: `src/features/settings/tabs/AITab.tsx`

- [ ] **Step 1: Create the component**

Create `src/features/settings/tabs/AITab/ClaudeCodeSection.tsx`:

```tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { claudeDetect, claudeRegisterMcp } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { SectionTitle } from "../../primitives/SectionTitle";
import { Field } from "../../primitives/Field";

export function ClaudeCodeSection() {
  const qc = useQueryClient();

  const { data: status } = useQuery({
    queryKey: queryKeys.claudeStatus(),
    queryFn: claudeDetect,
    staleTime: 10_000,
  });

  const register = useMutation({
    mutationFn: claudeRegisterMcp,
    onSuccess: (next) => qc.setQueryData(queryKeys.claudeStatus(), next),
  });

  return (
    <>
      <SectionTitle>Claude Code</SectionTitle>
      <Field label="Status">
        <div className="flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              status?.available ? "bg-signal-success" : "bg-text-muted/40"
            }`}
          />
          <span className="font-mono text-xs text-text-secondary">
            {!status
              ? "checking..."
              : !status.available
              ? "not installed"
              : status.mcp_registered
              ? "connected — MCP registered"
              : "installed — MCP not registered"}
          </span>
        </div>
      </Field>
      {status?.available && !status.mcp_registered && (
        <Field label="">
          <button
            onClick={() => register.mutate()}
            disabled={register.isPending}
            className="font-mono text-xs px-3 py-1 border border-semantic/40 text-semantic hover:bg-semantic/10 transition-all"
          >
            {register.isPending ? "registering..." : "Connect to Claude Code"}
          </button>
        </Field>
      )}
      {status?.available && status.mcp_registered && (
        <p className="font-mono text-[11px] text-text-muted mt-1">
          Ask view will use Claude Code for agentic multi-turn retrieval.
        </p>
      )}
      {!status?.available && (
        <p className="font-mono text-[11px] text-text-muted mt-1">
          Install Claude Code CLI to enable agentic chat. Local Ollama chat remains available.
        </p>
      )}
    </>
  );
}
```

- [ ] **Step 2: Render in AITab**

In `src/features/settings/tabs/AITab.tsx`, import and render at the top:

```tsx
import { ClaudeCodeSection } from "./AITab/ClaudeCodeSection";

export function AITab({ config, update }: TabProps) {
  return (
    <>
      <ClaudeCodeSection />
      <SectionTitle>Chat / Ask</SectionTitle>
      {/* ... existing fields ... */}
```

- [ ] **Step 3: Manual test**

Open Settings → AI tab:
- If Claude Code not installed: "not installed" shown.
- If installed but MCP not registered: "Connect to Claude Code" button appears; clicking it flips status to "connected".
- If already connected: descriptive text explains behavior.

- [ ] **Step 4: Commit**

```bash
git add src/features/settings/tabs/AITab/ClaudeCodeSection.tsx src/features/settings/tabs/AITab.tsx
git commit -m "add Claude Code settings section"
```

---

## Task 16: End-to-end verification

**Files:** None — manual verification only.

- [ ] **Step 1: Full Claude happy path**

Prereqs: daemon running, Claude Code installed, MCP registered.

1. Start app: `bun run tauri dev`
2. Open Ask view — header shows `· claude`.
3. Type: "what was I looking at in the last 30 minutes?"
4. Observe: brief "thinking..." pause, then full response arrives with real data and `[REF:N]` links to screenshots.
5. Click a reference — it opens the screenshot detail view.

- [ ] **Step 2: Ollama fallback path**

1. Remove `claude` from PATH (or uninstall): Ask view header shows `· local`.
2. Ensure Ollama is running with `qwen2.5:3b` pulled.
3. Ask the same question.
4. Observe: tokens stream in natively via `fetch` (typewriter effect), final message includes references.

- [ ] **Step 3: Cancellation**

- In Claude mode: ask a long question, click "stop" mid-response. The child process should be killed (verify with `ps aux | grep claude` — no lingering process).
- In Ollama mode: same. Verify token stream stops immediately (AbortController fires).

- [ ] **Step 4: Error handling**

- Stop Ollama while in local mode: header dot flips red, input disabled, no crash.
- Stop the daemon: `build_chat_context` should fail gracefully — error shows in the Ask view error bar.

- [ ] **Step 5: No commit** — verification checkpoint only.

---

## Self-review

**Spec coverage:**
- ✅ MCP server with 5 tools → Tasks 2-6
- ✅ `--mcp` subcommand, stdio transport → Tasks 1, 6
- ✅ Separate process with read-only DB → Task 6
- ✅ Thin wrappers over existing `Database` methods → Tasks 2-5
- ✅ One-click MCP registration → Task 9
- ✅ Manual MCP registration documented → Task 7
- ✅ Claude Code detection → Task 8
- ✅ Claude Code chat path → Task 11
- ✅ Ollama local path preserved → Tasks 12-13
- ✅ "claude" vs "local" indicator → Task 14 (in AskView)
- ✅ Cancellation for both paths → Tasks 11 (SIGTERM) + 13 (AbortController)
- ✅ Streaming cleanup (remove event protocol) → Task 14

**Placeholder scan:** The `rmcp` API note in Task 6 is a real external-version unknown with a fallback instruction, not a placeholder. All other steps have complete code. No TBDs.

**Type consistency:** `SearchScreenshotsInput`, `GetTimelineInput`, `GetAppUsageInput`, `GetScreenshotDetailInput`, `GetRecentActivityInput` defined in Tasks 2-5, used in Task 6. `ClaudeCodeStatus` defined in Task 8, used in Tasks 9, 14, 15. `ChatContext` defined in Task 10, used in Task 13. `OllamaMessage` / `OllamaChatOptions` defined in Task 12, used in Task 13.

**Scope:** 16 tasks. Tasks 1-7 build and verify the MCP server end-to-end. Tasks 8-11 add Tauri commands for Claude Code + context. Tasks 12-13 build the client-side chat. Tasks 14-15 remove the old architecture and add UI. Task 16 is verification. Each task is a single focused commit.
