# MCP Server + Claude Code Chat Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose RewindOS data to Claude Code via an MCP server, and route the in-app Ask view through the `claude` CLI when available, giving users multi-turn agentic retrieval over their screen history.

**Architecture:** The `rewindos-daemon` binary gains an `--mcp` mode that starts a stdio MCP server (separate process, read-only DB). Claude Code spawns it on demand when a tool is called. The Tauri app detects `claude` on PATH and, when present, routes Ask queries to `claude -p "..." --output-format stream-json` instead of Ollama. A unified `ask-stream` event replaces the three-event (`ask-token`/`ask-done`/`ask-error`) protocol on the Claude path.

**Tech Stack:** Rust (`rmcp` crate for MCP server), `rusqlite` (existing), Tauri v2 (`Command::new` for subprocess), React 19 + TanStack Query (frontend).

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `crates/rewindos-core/src/mcp.rs` | MCP tool implementations — thin functions over `Database` that return JSON-serializable structs. Pure, testable. |
| `crates/rewindos-daemon/src/mcp_server.rs` | MCP stdio server — wires the tools from `mcp.rs` into `rmcp`'s protocol handler. |
| `src-tauri/src/claude_code.rs` | Claude Code subprocess orchestration — detects `claude` on PATH, spawns with streaming, parses `stream-json` output, emits Tauri events. |
| `src/features/settings/tabs/AITab/ClaudeCodeSection.tsx` | Settings UI section — one-click MCP registration, connection status. |

### Modified files

| Path | Change |
|---|---|
| `crates/rewindos-core/Cargo.toml` | Add `rmcp` dependency. |
| `crates/rewindos-daemon/Cargo.toml` | Add `rmcp` dependency. |
| `crates/rewindos-daemon/src/main.rs` | Add `Mcp` subcommand that starts MCP server mode instead of the capture pipeline. |
| `src-tauri/src/lib.rs` | Add `claude_detect`, `claude_register_mcp` commands; refactor `ask` to route to Claude Code when available; emit unified `ask-stream` events on the Claude path. |
| `src-tauri/Cargo.toml` | Add `which = "7"` dependency for PATH detection. |
| `src/lib/api.ts` | Add `claudeDetect`, `claudeRegisterMcp` functions and `AskStreamPayload` type. |
| `src/context/AskContext.tsx` | Listen for unified `ask-stream` event alongside existing ones. |
| `src/features/ask/AskView.tsx` | Show "claude" or "local" indicator next to the Ollama online dot. |
| `src/features/settings/tabs/AITab.tsx` | Render `ClaudeCodeSection`. |

### Out of scope (deferred)

- Voice pipeline (separate plan)
- Proactive features / daily digests (P2)
- Unifying the local Ollama path to `ask-stream` (keep it on the old event protocol for now — can be cleaned up later)

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
Expected: Compiles (warnings OK). If `rmcp` version 0.2 doesn't exist, run `cargo search rmcp` and use the latest published version. Feature names (`server`, `transport-io`) may differ by version — check the crate docs and use the equivalent features that provide server-side stdio transport.

- [ ] **Step 3: Add `Mcp` subcommand to the daemon CLI**

In `crates/rewindos-daemon/src/main.rs`, extend the `Command` enum (currently around line 29):

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

And extend the match in `main()`:

```rust
match cli.command.unwrap_or(Command::Run) {
    Command::Run => run_daemon().await,
    Command::Pause => dbus_client_call("Pause").await,
    Command::Resume => dbus_client_call("Resume").await,
    Command::Status => dbus_client_status().await,
    Command::Backfill { batch_size } => run_backfill(batch_size).await,
    Command::BackfillOcr { batch_size } => run_backfill_ocr(batch_size).await,
    Command::Recompress { quality, max_width, thumb_width, dry_run } =>
        run_recompress(quality, max_width, thumb_width, dry_run).await,
    Command::Mcp => run_mcp_server().await,
}
```

Add a stub function at the end of `main.rs`:

```rust
async fn run_mcp_server() -> anyhow::Result<()> {
    anyhow::bail!("MCP server not yet implemented")
}
```

- [ ] **Step 4: Verify the CLI accepts the new subcommand**

Run: `cargo run -p rewindos-daemon -- mcp`
Expected: Prints the bail error "MCP server not yet implemented" and exits non-zero.

- [ ] **Step 5: Commit**

```bash
git add crates/rewindos-core/Cargo.toml crates/rewindos-daemon/Cargo.toml crates/rewindos-daemon/src/main.rs Cargo.lock
git commit -m "scaffold MCP subcommand and add rmcp dependency"
```

---

## Task 2: Implement `search_screenshots` MCP tool

**Files:**
- Create: `crates/rewindos-core/src/mcp.rs`
- Modify: `crates/rewindos-core/src/lib.rs` (export new module)

The tool functions live in `rewindos-core` because they wrap `Database` methods. The daemon's `mcp_server.rs` will just register them with `rmcp`.

- [ ] **Step 1: Export the module**

In `crates/rewindos-core/src/lib.rs`, add:
```rust
pub mod mcp;
```
(If `lib.rs` uses `mod foo; pub use foo::*;` style for other modules, match that pattern instead.)

- [ ] **Step 2: Write the failing test**

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
            ocr_snippet: {
                let s = r.matched_text;
                if s.chars().count() > 400 {
                    s.chars().take(400).collect::<String>() + "..."
                } else {
                    s
                }
            },
        })
        .collect())
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
        assert_eq!(results[0].app_name.as_deref(), Some("firefox"));
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
```

- [ ] **Step 3: Run the tests and verify they pass**

Run: `cargo test -p rewindos-core mcp::tests -- --nocapture`
Expected: Both tests pass. Some fields in `NewScreenshot` may not match the exact struct — check `crates/rewindos-core/src/schema.rs` and fix the field names. If `insert_screenshot` has a different signature, adjust. The test intent (seed → search → assert) stays the same.

- [ ] **Step 4: Commit**

```bash
git add crates/rewindos-core/src/mcp.rs crates/rewindos-core/src/lib.rs
git commit -m "add search_screenshots MCP tool implementation"
```

---

## Task 3: Implement `get_timeline` MCP tool

**Files:**
- Modify: `crates/rewindos-core/src/mcp.rs`

- [ ] **Step 1: Write the failing test**

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
            id,
            timestamp,
            app_name,
            window_title,
            ocr_snippet: {
                if ocr_text.chars().count() > 300 {
                    ocr_text.chars().take(300).collect::<String>() + "..."
                } else {
                    ocr_text
                }
            },
        })
        .collect())
}
```

Add to the `tests` module:

```rust
    #[test]
    fn timeline_returns_ordered_entries() {
        let db = Database::open_in_memory().unwrap();
        seed_screenshot(&db, "firefox", "A", "early", 1_700_000_000);
        seed_screenshot(&db, "code", "B", "middle", 1_700_000_500);
        seed_screenshot(&db, "slack", "C", "late", 1_700_001_000);

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
    }

    #[test]
    fn timeline_filters_by_app() {
        let db = Database::open_in_memory().unwrap();
        seed_screenshot(&db, "firefox", "A", "abc", 1_700_000_000);
        seed_screenshot(&db, "code", "B", "xyz", 1_700_000_500);

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
```

- [ ] **Step 2: Run the tests and verify they pass**

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

- [ ] **Step 1: Write the failing test**

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

Add to the tests module:

```rust
    #[test]
    fn app_usage_aggregates_by_app() {
        let db = Database::open_in_memory().unwrap();
        seed_screenshot(&db, "firefox", "A", "a", 1_700_000_000);
        seed_screenshot(&db, "firefox", "B", "b", 1_700_000_030);
        seed_screenshot(&db, "code", "C", "c", 1_700_000_060);

        let usage = get_app_usage(
            &db,
            GetAppUsageInput {
                start_time: 0,
                end_time: 2_000_000_000,
            },
            5, // 5-second capture interval
        )
        .unwrap();

        let firefox = usage.iter().find(|u| u.app_name == "firefox").unwrap();
        assert_eq!(firefox.screenshot_count, 2);
        assert!((firefox.minutes - (2.0 * 5.0 / 60.0)).abs() < 0.001);
    }
```

- [ ] **Step 2: Run the tests and verify they pass**

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

- [ ] **Step 1: Write the failing tests and implementations**

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
```

Add to tests module:

```rust
    #[test]
    fn screenshot_detail_returns_full_ocr() {
        let db = Database::open_in_memory().unwrap();
        let id = seed_screenshot(&db, "firefox", "title", "the full OCR body", 1_700_000_000);

        let detail = get_screenshot_detail(
            &db,
            GetScreenshotDetailInput { screenshot_id: id },
        )
        .unwrap()
        .unwrap();

        assert_eq!(detail.id, id);
        assert_eq!(detail.full_ocr_text, "the full OCR body");
    }

    #[test]
    fn screenshot_detail_returns_none_for_missing() {
        let db = Database::open_in_memory().unwrap();
        let detail = get_screenshot_detail(
            &db,
            GetScreenshotDetailInput { screenshot_id: 9999 },
        )
        .unwrap();
        assert!(detail.is_none());
    }

    #[test]
    fn recent_activity_filters_by_time() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_700_000_000;
        seed_screenshot(&db, "firefox", "A", "old", now - 3600); // 1hr ago
        seed_screenshot(&db, "code", "B", "new", now - 300);     // 5min ago

        let entries = get_recent_activity(
            &db,
            GetRecentActivityInput { minutes: 30 },
            now,
        )
        .unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].ocr_snippet.trim(), "new");
    }
```

- [ ] **Step 2: Run the tests and verify they pass**

Run: `cargo test -p rewindos-core mcp::tests`
Expected: 8 tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/rewindos-core/src/mcp.rs
git commit -m "add get_screenshot_detail and get_recent_activity MCP tools"
```

---

## Task 6: Wire MCP tools into an rmcp stdio server

**Files:**
- Create: `crates/rewindos-daemon/src/mcp_server.rs`
- Modify: `crates/rewindos-daemon/src/main.rs`

**Note on rmcp API:** The exact API (trait names, macro names, tool registration patterns) depends on which version of `rmcp` resolved in Task 1. Check `cargo doc -p rmcp --open` for the actual API. The code below uses the pattern from `rmcp 0.2.x` — if the resolved version differs, adapt. The *contract* to preserve:
- stdio transport (server reads from stdin, writes to stdout)
- 5 tools registered: `search_screenshots`, `get_timeline`, `get_app_usage`, `get_screenshot_detail`, `get_recent_activity`
- Each tool accepts JSON matching the input structs from `rewindos_core::mcp` and returns JSON of the output structs
- The server opens the database read-only and connects to Ollama only if reachable (for `search_screenshots` hybrid mode)

- [ ] **Step 1: Add the module**

In `crates/rewindos-daemon/src/main.rs`, at the top with the other `mod` declarations:

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

// rmcp imports — adapt to the resolved version. These names match rmcp 0.2.x.
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
        Self {
            db: Arc::new(db),
            capture_interval_seconds,
        }
    }

    fn tool_definitions() -> Vec<Tool> {
        // Each Tool wraps a name + JSON Schema for its input. See rmcp::model::Tool docs.
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
                let input: SearchScreenshotsInput =
                    serde_json::from_value(args).map_err(|e| e.to_string())?;
                let out =
                    search_screenshots(&self.db, input).map_err(|e| e.to_string())?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "get_timeline" => {
                let input: GetTimelineInput =
                    serde_json::from_value(args).map_err(|e| e.to_string())?;
                let out = get_timeline(&self.db, input).map_err(|e| e.to_string())?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "get_app_usage" => {
                let input: GetAppUsageInput =
                    serde_json::from_value(args).map_err(|e| e.to_string())?;
                let out = get_app_usage(&self.db, input, self.capture_interval_seconds)
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "get_screenshot_detail" => {
                let input: GetScreenshotDetailInput =
                    serde_json::from_value(args).map_err(|e| e.to_string())?;
                let out =
                    get_screenshot_detail(&self.db, input).map_err(|e| e.to_string())?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            "get_recent_activity" => {
                let input: GetRecentActivityInput =
                    serde_json::from_value(args).map_err(|e| e.to_string())?;
                let now = chrono::Local::now().timestamp();
                let out = get_recent_activity(&self.db, input, now)
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(out).map_err(|e| e.to_string())
            }
            _ => Err(format!("unknown tool: {name}")),
        }
    }
}

// Implement ServerHandler per rmcp's trait. The exact method signatures may differ —
// check `cargo doc -p rmcp` for the resolved version.
impl ServerHandler for RewindosMcpServer {
    async fn list_tools(
        &self,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<Vec<Tool>, McpError> {
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
    // Open DB read-only. The running daemon holds a writer in WAL mode; concurrent readers are fine.
    let db_path = config.db_path()?;
    let db = Database::open(&db_path)?;

    let server = RewindosMcpServer::new(db, config.capture.interval_seconds);
    let (stdin, stdout) = stdio();
    Server::new(server).serve(stdin, stdout).await?;
    Ok(())
}
```

- [ ] **Step 3: Wire the run function into the CLI**

In `crates/rewindos-daemon/src/main.rs`, replace the stub `run_mcp_server`:

```rust
async fn run_mcp_server() -> anyhow::Result<()> {
    // Deliberately do NOT call init_logging() — it would write tracing to stdout/stderr
    // and corrupt the MCP stdio protocol. If diagnostics are needed, write to a file.
    let config = AppConfig::load()?;
    mcp_server::run(config).await
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo check -p rewindos-daemon`
Expected: Compiles. If rmcp's API names don't match (e.g. `ServerHandler` is actually `ToolsServer`, `stdio()` is `io::stdio()`, etc.), fix them. The *shape* — a server struct that registers tools and handles `call_tool` — is the contract.

- [ ] **Step 5: Manual smoke test**

Run the binary in MCP mode and send a simple MCP `initialize` message:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' | cargo run -p rewindos-daemon -- mcp
```

Expected: A JSON-RPC response on stdout with `serverInfo.name` and capabilities. If this works, the stdio protocol is wired correctly.

- [ ] **Step 6: Commit**

```bash
git add crates/rewindos-daemon/src/mcp_server.rs crates/rewindos-daemon/src/main.rs
git commit -m "wire MCP tools into rmcp stdio server"
```

---

## Task 7: End-to-end test with Claude Code

**Files:**
- No code changes — manual verification

- [ ] **Step 1: Register the MCP server in Claude Code**

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

Get the absolute path with: `ls $PWD/target/debug/rewindos-daemon`

- [ ] **Step 2: Verify Claude Code discovers the tools**

Run: `claude mcp list`
Expected: `rewindos` shown with its 5 tools.

- [ ] **Step 3: Invoke a tool via Claude Code**

Run: `claude -p "Use the rewindos MCP to list recent activity from the last 30 minutes, then summarize"`
Expected: Claude Code calls `get_recent_activity` and responds with a summary based on real data. If the DB is empty, it should say so.

- [ ] **Step 4: No commit** — this is a verification checkpoint only.

---

## Task 8: Tauri command to detect Claude Code

**Files:**
- Create: `src-tauri/src/claude_code.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add `which` dependency**

In `src-tauri/Cargo.toml`, add to `[dependencies]`:
```toml
which = "7"
```

- [ ] **Step 2: Create the module skeleton**

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
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let settings_path = home.join(".claude").join("settings.json");
    let Ok(contents) = std::fs::read_to_string(&settings_path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return false;
    };
    json.get("mcpServers")
        .and_then(|m| m.get("rewindos"))
        .is_some()
}
```

- [ ] **Step 3: Declare the module and command**

In `src-tauri/src/lib.rs`, near the top:

```rust
mod claude_code;
```

Add the Tauri command (near the other `ask_*` commands around line 649):

```rust
#[tauri::command]
fn claude_detect() -> claude_code::ClaudeCodeStatus {
    claude_code::detect()
}
```

Register it in `invoke_handler` (around line 1780):

```rust
// ... existing commands ...
ask_new_session,
ask_health,
ask_cancel,
claude_detect,
```

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

Run: `cargo check -p rewindos` (the Tauri crate)
Expected: Compiles.

Start the app: `bun run tauri dev`
In DevTools console:
```javascript
await window.__TAURI__.core.invoke("claude_detect")
```
Expected: `{available: true/false, path: "...", mcp_registered: true/false}`

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/claude_code.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src/lib/api.ts Cargo.lock
git commit -m "add claude_detect Tauri command"
```

---

## Task 9: One-click MCP registration command

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
        let contents =
            std::fs::read_to_string(&settings_path).map_err(|e| format!("read: {e}"))?;
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

In `src-tauri/src/lib.rs`, next to `claude_detect`:

```rust
#[tauri::command]
fn claude_register_mcp() -> Result<claude_code::ClaudeCodeStatus, String> {
    claude_code::register_mcp()?;
    Ok(claude_code::detect())
}
```

Register it in `invoke_handler`:

```rust
claude_detect,
claude_register_mcp,
```

- [ ] **Step 3: Expose in the frontend API**

In `src/lib/api.ts`:

```typescript
export async function claudeRegisterMcp(): Promise<ClaudeCodeStatus> {
  return invoke("claude_register_mcp");
}
```

- [ ] **Step 4: Manual test**

Start the app. In DevTools:
```javascript
await window.__TAURI__.core.invoke("claude_register_mcp")
```
Then inspect `~/.claude/settings.json` — it should contain an `mcpServers.rewindos` entry pointing at the daemon binary.

Confirm with: `claude mcp list`
Expected: `rewindos` listed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/claude_code.rs src-tauri/src/lib.rs src/lib/api.ts
git commit -m "add claude_register_mcp command for one-click MCP setup"
```

---

## Task 10: Claude Code chat streaming via subprocess

**Files:**
- Modify: `src-tauri/src/claude_code.rs`
- Modify: `src-tauri/src/lib.rs`

This is the key integration: spawn `claude -p "..." --output-format stream-json`, parse NDJSON from stdout, emit `ask-stream` events, and support cancellation via killing the child process.

- [ ] **Step 1: Add the streaming function**

In `src-tauri/src/claude_code.rs`, append:

```rust
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::watch;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AskStreamChunk {
    Text { content: String },
    ToolUse { tool: String },
    Done { content: String },
    Error { message: String },
}

pub async fn spawn_claude_chat(prompt: &str) -> Result<Child, String> {
    Command::new("claude")
        .arg("-p")
        .arg(prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose") // required when using stream-json per Claude Code docs
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn claude: {e}"))
}

/// Consume stdout NDJSON from claude, yielding parsed AskStreamChunk events.
/// Returns when the child exits (done) or the cancel signal fires.
pub async fn stream_chunks<F>(
    mut child: Child,
    mut cancel: watch::Receiver<bool>,
    mut on_chunk: F,
) -> Result<String, String>
where
    F: FnMut(AskStreamChunk),
{
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut reader = BufReader::new(stdout).lines();
    let mut accumulated = String::new();

    loop {
        tokio::select! {
            line = reader.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() { continue; }
                        match parse_stream_line(&line) {
                            Some(AskStreamChunk::Text { content }) => {
                                accumulated.push_str(&content);
                                on_chunk(AskStreamChunk::Text { content });
                            }
                            Some(chunk) => on_chunk(chunk),
                            None => {
                                // Unknown event type — skip silently
                            }
                        }
                    }
                    Ok(None) => break, // EOF
                    Err(e) => return Err(format!("read stdout: {e}")),
                }
            }
            _ = cancel.changed() => {
                if *cancel.borrow() {
                    let _ = child.kill().await;
                    break;
                }
            }
        }
    }

    on_chunk(AskStreamChunk::Done {
        content: accumulated.clone(),
    });
    Ok(accumulated)
}

/// Parse one line of Claude Code's `stream-json` output into our event type.
/// Claude Code emits events like:
///   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
///   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"search_screenshots"}]}}
///   {"type":"result","result":"..."}
fn parse_stream_line(line: &str) -> Option<AskStreamChunk> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let kind = v.get("type")?.as_str()?;

    match kind {
        "assistant" => {
            let content_arr = v.get("message")?.get("content")?.as_array()?;
            for item in content_arr {
                let item_type = item.get("type")?.as_str()?;
                match item_type {
                    "text" => {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            return Some(AskStreamChunk::Text {
                                content: text.to_string(),
                            });
                        }
                    }
                    "tool_use" => {
                        if let Some(name) = item.get("name").and_then(|t| t.as_str()) {
                            return Some(AskStreamChunk::ToolUse {
                                tool: name.to_string(),
                            });
                        }
                    }
                    _ => {}
                }
            }
            None
        }
        "result" => {
            // Final aggregated result — we already streamed text chunks, so ignore.
            None
        }
        _ => None,
    }
}
```

- [ ] **Step 2: Route `ask` through Claude Code when available**

In `src-tauri/src/lib.rs`, inside the `ask` command function, just after building the `user_message` and history (around line 892), add a branch that takes the Claude path. Insert this block right before the existing `tokio::spawn(async move { ... ollama chat ... })`:

Find this section in the existing `ask` function:
```rust
    // 4. Spawn streaming task with cancel support
    let session_id_clone = session_id.clone();
    let chat_sessions = state.chat_sessions.clone();
    let cancel_tokens = state.ask_cancel_tokens.clone();

    // Create cancel channel
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
```

Just before this section, add:

```rust
    // Detect Claude Code once per call (cheap — it's a PATH lookup + file read)
    let claude_status = claude_code::detect();
    let use_claude = claude_status.available && claude_status.mcp_registered;
```

Then rewrite the spawn block to branch on `use_claude`:

```rust
    // 4. Spawn streaming task with cancel support
    let session_id_clone = session_id.clone();
    let chat_sessions = state.chat_sessions.clone();
    let cancel_tokens = state.ask_cancel_tokens.clone();

    let (cancel_tx, cancel_rx) = watch::channel(false);
    {
        let mut tokens = cancel_tokens
            .lock()
            .map_err(|e| format!("lock: {e}"))?;
        tokens.insert(session_id.clone(), cancel_tx);
    }

    if use_claude {
        // Build the prompt: inline the context and user message, since Claude Code
        // will call MCP tools itself for retrieval when it needs more data.
        let prompt = format!(
            "{}\n\nUser question: {}\n\nInitial context from RewindOS:\n{}",
            SYSTEM_PROMPT, message, context
        );

        let app_clone = app.clone();
        tokio::spawn(async move {
            let child = match claude_code::spawn_claude_chat(&prompt).await {
                Ok(c) => c,
                Err(e) => {
                    let _ = app_clone.emit(
                        "ask-stream",
                        serde_json::json!({
                            "session_id": session_id_clone,
                            "type": "error",
                            "message": e
                        }),
                    );
                    return;
                }
            };

            let emit_app = app_clone.clone();
            let emit_sid = session_id_clone.clone();
            let result = claude_code::stream_chunks(child, cancel_rx, move |chunk| {
                let payload = match &chunk {
                    claude_code::AskStreamChunk::Text { content } => serde_json::json!({
                        "session_id": emit_sid,
                        "type": "text",
                        "content": content,
                    }),
                    claude_code::AskStreamChunk::ToolUse { tool } => serde_json::json!({
                        "session_id": emit_sid,
                        "type": "tool_use",
                        "tool": tool,
                    }),
                    claude_code::AskStreamChunk::Done { content } => serde_json::json!({
                        "session_id": emit_sid,
                        "type": "done",
                        "content": content,
                    }),
                    claude_code::AskStreamChunk::Error { message } => serde_json::json!({
                        "session_id": emit_sid,
                        "type": "error",
                        "message": message,
                    }),
                };
                let _ = emit_app.emit("ask-stream", payload);
            })
            .await;

            // Store the full response in chat history
            if let Ok(full) = result {
                if !full.is_empty() {
                    if let Ok(mut sessions) = chat_sessions.lock() {
                        if let Some(history) = sessions.get_mut(&session_id_clone) {
                            history.push(ChatMessage {
                                role: ChatRole::Assistant,
                                content: full,
                            });
                        }
                    }
                }
            }

            if let Ok(mut tokens) = cancel_tokens.lock() {
                tokens.remove(&session_id_clone);
            }
        });

        return Ok(AskResponse {
            session_id,
            references,
        });
    }

    // --- Existing Ollama path below unchanged ---
    let mut cancel_rx = cancel_rx; // keep compiler happy — old path consumes this
```

Note: the existing Ollama spawn code already takes `cancel_rx` by value. Make sure only one branch consumes it — the `if use_claude` branch returns early so the Ollama code still owns `cancel_rx` on its path.

- [ ] **Step 3: Verify it compiles**

Run: `cargo check -p rewindos`
Expected: Compiles. Watch for borrow errors around `cancel_rx` — if both branches try to move it, restructure with `let (cancel_tx, cancel_rx) = watch::channel(false)` moved inside each branch instead.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/claude_code.rs src-tauri/src/lib.rs
git commit -m "route Ask view to Claude Code subprocess with stream-json parsing"
```

---

## Task 11: Frontend handling of `ask-stream` events

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/context/AskContext.tsx`

- [ ] **Step 1: Add the stream payload type**

In `src/lib/api.ts`, append:

```typescript
export type AskStreamPayload =
  | { session_id: string; type: "text"; content: string }
  | { session_id: string; type: "tool_use"; tool: string }
  | { session_id: string; type: "done"; content: string }
  | { session_id: string; type: "error"; message: string };
```

- [ ] **Step 2: Subscribe to `ask-stream` in AskContext**

In `src/context/AskContext.tsx`, add a new listener alongside the existing `ask-token`/`ask-done`/`ask-error` listeners. Inside the `useEffect` at line 69:

```typescript
import { type AskStreamPayload } from "@/lib/api";

// ... inside useEffect, after the existing unlisteners.push() calls:

unlisteners.push(
  listen<AskStreamPayload>("ask-stream", (event) => {
    if (event.payload.session_id !== sessionIdRef.current) return;

    const payload = event.payload;
    if (payload.type === "text") {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant") {
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + payload.content },
          ];
        }
        return prev;
      });
    } else if (payload.type === "tool_use") {
      // Show a subtle indicator that Claude is calling a tool
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant") {
          return [
            ...prev.slice(0, -1),
            { ...last, toolUses: [...(last.toolUses ?? []), payload.tool] },
          ];
        }
        return prev;
      });
    } else if (payload.type === "done") {
      setIsStreaming(false);
    } else if (payload.type === "error") {
      setError(payload.message);
      setIsStreaming(false);
    }
  }),
);
```

- [ ] **Step 3: Extend the `ChatMessage` type with `toolUses`**

In `src/context/AskContext.tsx`, at line 21:

```typescript
export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  references?: ScreenshotRef[];
  toolUses?: string[];
}
```

- [ ] **Step 4: Render tool use indicators in ChatMessage**

In `src/features/ask/ChatMessage.tsx`, after the assistant content area and before the references footer, render a row of tool badges if `toolUses` is non-empty:

```tsx
{message.toolUses && message.toolUses.length > 0 && (
  <div className="mt-2 flex flex-wrap gap-1">
    {message.toolUses.map((tool, i) => (
      <span
        key={i}
        className="font-mono text-[10px] text-semantic/70 border border-semantic/20 px-1.5 py-0.5 uppercase tracking-wider"
      >
        {tool}
      </span>
    ))}
  </div>
)}
```

(If the existing `ChatMessage.tsx` has a different structure, place the badges in the closest equivalent location — below the text body, above any references.)

- [ ] **Step 5: Manual end-to-end test**

With Claude Code installed and MCP registered:
1. Start the app: `bun run tauri dev`
2. Ensure the daemon is running so screenshots exist: `cargo run -p rewindos-daemon`
3. Open the Ask view, type: "What have I been doing in the last 30 minutes?"
4. Expected: streaming text appears, tool badges (e.g. `get_recent_activity`) flash, final response cites real screenshot data.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/context/AskContext.tsx src/features/ask/ChatMessage.tsx
git commit -m "handle ask-stream events and render tool-use badges"
```

---

## Task 12: Indicator + settings UI for Claude Code

**Files:**
- Create: `src/features/settings/tabs/AITab/ClaudeCodeSection.tsx`
- Modify: `src/features/settings/tabs/AITab.tsx`
- Modify: `src/features/ask/AskView.tsx`
- Modify: `src/lib/query-keys.ts`

- [ ] **Step 1: Add a query key**

In `src/lib/query-keys.ts`, in the `queryKeys` object:

```typescript
claudeStatus: () => ["claude-status"] as const,
```

- [ ] **Step 2: Create the ClaudeCodeSection component**

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

- [ ] **Step 3: Render it in AITab**

In `src/features/settings/tabs/AITab.tsx`, import and render at the top:

```tsx
import { ClaudeCodeSection } from "./AITab/ClaudeCodeSection";
// ...
export function AITab({ config, update }: TabProps) {
  return (
    <>
      <ClaudeCodeSection />
      <SectionTitle>Chat / Ask</SectionTitle>
      {/* ... existing content ... */}
```

- [ ] **Step 4: Add the indicator to AskView**

In `src/features/ask/AskView.tsx`, next to the existing Ollama online dot (around line 88), add a second indicator:

```tsx
import { claudeDetect } from "@/lib/api";

// Inside AskView component, alongside askHealth:
const { data: claudeStatus } = useQuery({
  queryKey: queryKeys.claudeStatus(),
  queryFn: claudeDetect,
  refetchInterval: 60_000,
  staleTime: 30_000,
});

const usingClaude = claudeStatus?.available && claudeStatus.mcp_registered;
```

And in the header bar JSX, replace:

```tsx
<span className="font-mono text-xs text-text-muted uppercase tracking-wider">
  ask
</span>
```

with:

```tsx
<span className="font-mono text-xs text-text-muted uppercase tracking-wider">
  ask
</span>
<span
  className={`font-mono text-[10px] uppercase tracking-wider ${
    usingClaude ? "text-semantic" : "text-text-muted"
  }`}
  title={usingClaude ? "Using Claude Code (agentic)" : "Using local Ollama"}
>
  · {usingClaude ? "claude" : "local"}
</span>
```

- [ ] **Step 5: Manual test**

1. Start the app.
2. Open Settings → AI tab — verify Claude Code section renders correctly whether installed or not.
3. If installed but not registered, click "Connect to Claude Code" — verify status flips to "connected".
4. Open Ask view — verify the header badge shows "claude" or "local" based on state.

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/tabs/AITab src/features/settings/tabs/AITab.tsx src/features/ask/AskView.tsx src/lib/query-keys.ts
git commit -m "add Claude Code settings section and Ask view indicator"
```

---

## Task 13: End-to-end verification

**Files:**
- None — manual verification

- [ ] **Step 1: Full happy-path test**

Prerequisites:
- `cargo build --workspace` succeeds
- `bun run tauri dev` starts the app
- Daemon is running: `cargo run -p rewindos-daemon`
- Claude Code is installed: `which claude` returns a path
- Some screenshots exist with OCR text

Flow:
1. Open Settings → AI tab
2. Click "Connect to Claude Code" — status flips to "connected"
3. Open Ask view — header shows "claude"
4. Type: "What was I working on in the last hour?"
5. Observe: streaming tokens arrive, tool-use badges flash (`get_recent_activity` or similar), response cites real timestamps and app names from the database

- [ ] **Step 2: Fallback path test**

1. Rename `claude` temporarily: `sudo mv $(which claude) /tmp/claude.bak` (or remove it from PATH for your shell session)
2. Restart the app
3. Ask view header should show "local"
4. Same question goes through Ollama — slower, less accurate, but functional
5. Restore: `sudo mv /tmp/claude.bak $(which claude)` or reset PATH

- [ ] **Step 3: Cancellation test**

1. In claude mode, ask a long-running question
2. Click "stop" while Claude is mid-response
3. Expected: child process is killed, UI stops streaming, partial response remains visible

- [ ] **Step 4: No commit** — verification only.

---

## Self-review

**Spec coverage:**
- ✅ MCP server with 5 tools → Tasks 2-6
- ✅ Stdio transport, `--mcp` CLI flag → Task 6
- ✅ Separate process with read-only DB → Task 6 (WAL concurrent readers noted in module docs)
- ✅ Tool wrappers over existing `Database` methods → Tasks 2-5
- ✅ One-click MCP registration → Task 9
- ✅ Manual MCP registration path → Documented in Task 7
- ✅ Claude Code detection → Task 8
- ✅ Subprocess spawn with `stream-json` → Task 10
- ✅ Unified `ask-stream` event → Tasks 10-11
- ✅ Tool-use badges in UI → Task 11
- ✅ "claude" vs "local" indicator → Task 12
- ✅ Local Ollama path preserved as fallback → Task 10 (branch on `use_claude`)
- ✅ Cancellation via kill_on_drop + watch channel → Task 10

**Placeholder scan:** No TBDs or "TODO later" comments in the plan. The `rmcp` API is noted as version-dependent with a fallback instruction (check `cargo doc`) — this is a genuine external-API unknown, not a placeholder.

**Type consistency:** `SearchScreenshotsInput`, `GetTimelineInput`, `GetAppUsageInput`, `GetScreenshotDetailInput`, `GetRecentActivityInput` defined in Task 2-5, used in Task 6. `AskStreamChunk`, `ClaudeCodeStatus` defined in Tasks 8/10, used in Tasks 10-12 consistently.

**Scope:** 13 tasks, each a single focused commit. First 7 build and verify the MCP server. Tasks 8-12 wire the Tauri integration. Task 13 is final verification. Total surface area is appropriate for one implementation session.
