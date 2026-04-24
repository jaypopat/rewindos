# Streaming Chat + Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blocking `ask_claude` subprocess call with a streaming pipeline that surfaces Claude's tool calls and thinking blocks in the Ask view, persists chat history to SQLite (with FTS over chat text), and adds a sidebar for creating, switching, searching, renaming, deleting, and exporting multiple chat sessions.

**Architecture:** The daemon-side `ask_claude` Tauri command spawns `claude -p "<user>" --output-format stream-json --verbose --append-system-prompt "<system>" --session-id "<uuid>"` and reads stdout line-by-line. Each JSON line is mapped into a typed `AskStreamEvent` and delivered to the frontend through a Tauri v2 `Channel<AskStreamEvent>`. Events are persisted to new `chats` and `chat_messages` tables as they arrive (crash-safe). The frontend reads chat state via TanStack Query against those tables — React `useState` history is retired. The Ollama path writes to the same tables (with `claude_session_id = NULL`), giving both backends identical UX. A left sidebar lists chats, supports FTS-backed search, rename, delete, and markdown export.

**Tech Stack:** Rust (`tokio::process::Command`, `tokio::io::BufReader`, `serde` tagged enums, `rusqlite` + FTS5, `refinery` V007 migration), Tauri v2 `Channel<T>` for stream delivery, React 19 + TanStack Query for DB-backed state, existing `ollama-chat.ts` for the local path.

---

## Architectural Principles

1. **Stream-json is the right layer.** The CLI's `--output-format=stream-json` is the documented integration boundary for embedded Claude Code. We consume events, Claude doesn't format text for us. This also disposes of the "explanatory output style leaks into the Ask view" problem — we render chrome ourselves.

2. **One storage shape for both backends.** Claude chats and Ollama chats live in the same two tables. The only difference is `claude_session_id`: present for Claude, null for Ollama. UX code doesn't branch on backend — render logic is uniform.

3. **Persist per-event, not per-message.** Each content block (text token batch, tool_use, tool_result, thinking) is an insert. A crash mid-response leaves a partial but valid message. Cancellation marks the message as incomplete rather than deleting it.

4. **Session ids are the source of truth for continuity.** When the user sends a second message in an existing Claude chat, we spawn with `--resume <session_id>` — Claude reads its own `~/.claude/projects/<hash>/<session_id>.jsonl` for conversation context. We don't replay history; we mirror it.

```
┌─────────────────────────────────────────────────────┐
│  Frontend (React)                                    │
│                                                      │
│  ChatSidebar ── list/search/new/rename/delete/export │
│  AskView     ── active chat_id, messages, input       │
│                                                      │
│  useChats / useChatMessages (TanStack Query)         │
│  new AbortController + Channel<AskStreamEvent>        │
└─────────────────────────────────────────────────────┘
                    │ invoke() + Channel
                    ▼
┌─────────────────────────────────────────────────────┐
│  Tauri (Rust)                                        │
│                                                      │
│  chat_commands (create/list/get/rename/delete/search)│
│  ask_claude    ── streams via --output-format=       │
│                   stream-json, re-emits AskStreamEvent│
│  persist_event ── writes to chat_messages per event  │
└─────────────────────────────────────────────────────┘
                    │ rusqlite
                    ▼
┌─────────────────────────────────────────────────────┐
│  SQLite                                              │
│    chats(id, title, claude_session_id, created_at)   │
│    chat_messages(id, chat_id, role, block_type,      │
│                  content_json, created_at)           │
│    chat_messages_fts — FTS5 over text blocks         │
└─────────────────────────────────────────────────────┘
```

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `crates/rewindos-core/migrations/V007__chats.sql` | Schema: `chats`, `chat_messages`, `chat_messages_fts`, triggers. |
| `crates/rewindos-core/src/chat_store.rs` | `Database` methods for chat CRUD + message append + FTS search. Thin wrappers over SQL. |
| `src-tauri/src/chat_commands.rs` | Tauri commands for chat CRUD + markdown export. |
| `src-tauri/src/ask_stream.rs` | Parses claude's stream-json NDJSON into typed `AskStreamEvent`, pushes to channel, persists to DB. |
| `src/features/ask/ChatSidebar.tsx` | Chat list, search, new/rename/delete/export. |
| `src/features/ask/blocks/ToolUseBlock.tsx` | Collapsible card: tool name + input JSON. |
| `src/features/ask/blocks/ToolResultBlock.tsx` | Collapsible card: tool result body. |
| `src/features/ask/blocks/ThinkingBlock.tsx` | Collapsible card: model thinking text. |
| `src/features/ask/blocks/TextBlock.tsx` | Rendered assistant prose (extracted from current `ChatMessage.tsx` body). |
| `src/lib/chat-stream.ts` | Frontend event type + Channel plumbing helper. |

### Modified files

| Path | Change |
|---|---|
| `crates/rewindos-core/src/schema.rs` | Add `Chat`, `ChatMessageRow`, `ChatRole`, `ContentBlockKind`, `StoredContentBlock`. |
| `crates/rewindos-core/src/lib.rs` | `pub mod chat_store;`. |
| `crates/rewindos-core/src/error.rs` | No change unless new error variants needed — verify in Task 1. |
| `src-tauri/src/claude_code.rs` | `ask_claude_spawn` updated to include `--output-format stream-json --verbose --append-system-prompt --session-id` (and `--resume` on subsequent turns). Returns stdout reader, not a child to wait on. |
| `src-tauri/src/lib.rs` | Register new commands. Remove old `ask_claude` / `ask_claude_cancel` single-shot versions — replace with streaming variant. |
| `src/lib/api.ts` | Add `listChats`, `getChatMessages`, `createChat`, `renameChat`, `deleteChat`, `searchChats`, `exportChatMarkdown`. Replace `askClaude(sessionId, prompt): Promise<string>` with `askClaudeStream(chatId, prompt, channel, signal): Promise<void>`. |
| `src/lib/query-keys.ts` | Add `chats`, `chatMessages(chatId)`, `chatSearch(query)`. |
| `src/context/AskContext.tsx` | Rewrite: active `chatId`, TanStack Query for messages, Channel-driven event handling, Ollama parity (persist to DB). |
| `src/features/ask/AskView.tsx` | Render `ChatSidebar` + active-chat message list; remove inline-only history. |
| `src/features/ask/ChatMessage.tsx` | Dispatch on block type to `TextBlock` / `ToolUseBlock` / `ToolResultBlock` / `ThinkingBlock`. |

### Out of scope (deferred)

- LLM-generated chat titles (first-user-message truncation is fine for MVP).
- Voice pipeline (separate plan).
- Bulk export, multi-chat merge, share/sync.
- Model switcher UI (one Claude path, one Ollama path, same as today).
- Resuming an Ollama chat under Claude (or vice versa) — switching backend creates a new chat.

---

## Task 1: Add V007 migration — `chats` + `chat_messages` + FTS

**Files:**
- Create: `crates/rewindos-core/migrations/V007__chats.sql`
- Modify: `crates/rewindos-core/src/schema.rs`
- Modify: `crates/rewindos-core/src/lib.rs`

- [ ] **Step 1: Write the migration SQL**

Create `crates/rewindos-core/migrations/V007__chats.sql`:

```sql
CREATE TABLE chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    claude_session_id TEXT,
    backend TEXT NOT NULL CHECK (backend IN ('claude', 'ollama')),
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
);

CREATE INDEX idx_chats_last_activity ON chats(last_activity_at DESC);
CREATE UNIQUE INDEX idx_chats_claude_session
    ON chats(claude_session_id)
    WHERE claude_session_id IS NOT NULL;

CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    block_type TEXT NOT NULL CHECK (block_type IN ('text', 'tool_use', 'tool_result', 'thinking')),
    content_json TEXT NOT NULL,
    is_partial INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_chat_messages_chat ON chat_messages(chat_id, created_at);

CREATE VIRTUAL TABLE chat_messages_fts USING fts5(
    body,
    content='',
    contentless_delete=1
);

CREATE TRIGGER chat_messages_ai AFTER INSERT ON chat_messages
WHEN NEW.block_type IN ('text', 'thinking')
BEGIN
    INSERT INTO chat_messages_fts(rowid, body)
    VALUES (NEW.id, json_extract(NEW.content_json, '$.text'));
END;

CREATE TRIGGER chat_messages_ad AFTER DELETE ON chat_messages
WHEN OLD.block_type IN ('text', 'thinking')
BEGIN
    DELETE FROM chat_messages_fts WHERE rowid = OLD.id;
END;
```

*Why this shape:*
- `block_type` matches Claude's content-block discriminator, so inserting events from stream-json is a direct mapping.
- `content_json` keeps the block payload verbatim — text stays as `{"text": "..."}`, `tool_use` stays as `{"id":"...","name":"...","input":{...}}`, `tool_result` stays as `{"tool_use_id":"...","content":"..."}`. Rendering decodes per block_type.
- FTS indexes only `text` and `thinking` content via `json_extract` in a trigger — tool call JSON would clutter search results. `contentless_delete=1` lets us drop rows without keeping the body duplicated.
- `is_partial=1` marks messages interrupted by cancel; rendering shows a "stopped" indicator.
- `ON DELETE CASCADE` + FTS delete trigger makes `DELETE FROM chats WHERE id = ?` fully clean up.

- [ ] **Step 2: Add shared types**

In `crates/rewindos-core/src/schema.rs`, append:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Chat {
    pub id: i64,
    pub title: String,
    pub claude_session_id: Option<String>,
    pub backend: ChatBackend,
    pub created_at: i64,
    pub last_activity_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatBackend {
    Claude,
    Ollama,
}

impl ChatBackend {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChatBackend::Claude => "claude",
            ChatBackend::Ollama => "ollama",
        }
    }
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(ChatBackend::Claude),
            "ollama" => Some(ChatBackend::Ollama),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

impl ChatRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
        }
    }
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "user" => Some(ChatRole::User),
            "assistant" => Some(ChatRole::Assistant),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Text,
    ToolUse,
    ToolResult,
    Thinking,
}

impl BlockKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            BlockKind::Text => "text",
            BlockKind::ToolUse => "tool_use",
            BlockKind::ToolResult => "tool_result",
            BlockKind::Thinking => "thinking",
        }
    }
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "text" => Some(BlockKind::Text),
            "tool_use" => Some(BlockKind::ToolUse),
            "tool_result" => Some(BlockKind::ToolResult),
            "thinking" => Some(BlockKind::Thinking),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessageRow {
    pub id: i64,
    pub chat_id: i64,
    pub role: ChatRole,
    pub block_type: BlockKind,
    /// Raw JSON body; shape depends on block_type.
    /// text/thinking: { "text": String }
    /// tool_use:      { "id": String, "name": String, "input": JSON }
    /// tool_result:   { "tool_use_id": String, "content": String, "is_error"?: bool }
    pub content_json: String,
    pub is_partial: bool,
    pub created_at: i64,
}
```

- [ ] **Step 3: Verify the migration is picked up**

Refinery's `embed_migrations!("migrations")` macro auto-discovers V007 once the file exists. No code change in `db.rs`. Add a quick test to confirm the tables exist after opening an in-memory DB.

In `crates/rewindos-core/src/db.rs`, add to the existing test module (grep `#[cfg(test)]` for its location):

```rust
    #[test]
    fn v007_creates_chat_tables() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert!(tables.iter().any(|t| t == "chats"), "chats: {tables:?}");
        assert!(tables.iter().any(|t| t == "chat_messages"), "chat_messages: {tables:?}");
        assert!(tables.iter().any(|t| t == "chat_messages_fts"), "fts: {tables:?}");
    }
```

Run: `cargo test -p rewindos-core v007_creates_chat_tables`
Expected: PASS.

If `Database::conn` isn't directly accessible from tests (it may be private — check `db.rs`), use an existing helper like calling one of the `get_*` methods that would fail if the table is missing. Pattern in the existing tests will show the right approach.

- [ ] **Step 4: Commit**

```bash
git add crates/rewindos-core/migrations/V007__chats.sql \
        crates/rewindos-core/src/schema.rs \
        crates/rewindos-core/src/db.rs
git commit -m "add V007 migration for chats, chat_messages, FTS"
```

---

## Task 2: `chat_store` module — create/list/get chats

**Files:**
- Create: `crates/rewindos-core/src/chat_store.rs`
- Modify: `crates/rewindos-core/src/lib.rs`

- [ ] **Step 1: Export the module**

In `crates/rewindos-core/src/lib.rs`, add:
```rust
pub mod chat_store;
```

- [ ] **Step 2: Write the module with failing tests**

Create `crates/rewindos-core/src/chat_store.rs`:

```rust
use crate::db::Database;
use crate::error::Result;
use crate::schema::{Chat, ChatBackend};

pub fn create_chat(
    db: &Database,
    title: &str,
    backend: ChatBackend,
    claude_session_id: Option<&str>,
) -> Result<i64> {
    let now = chrono::Local::now().timestamp();
    let conn = db.conn();
    conn.execute(
        "INSERT INTO chats (title, claude_session_id, backend, created_at, last_activity_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        rusqlite::params![title, claude_session_id, backend.as_str(), now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_chats(db: &Database, limit: i64) -> Result<Vec<Chat>> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, title, claude_session_id, backend, created_at, last_activity_at
         FROM chats ORDER BY last_activity_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        let backend_str: String = r.get(3)?;
        Ok(Chat {
            id: r.get(0)?,
            title: r.get(1)?,
            claude_session_id: r.get(2)?,
            backend: ChatBackend::from_str(&backend_str).unwrap_or(ChatBackend::Claude),
            created_at: r.get(4)?,
            last_activity_at: r.get(5)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

pub fn get_chat(db: &Database, chat_id: i64) -> Result<Option<Chat>> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, title, claude_session_id, backend, created_at, last_activity_at
         FROM chats WHERE id = ?1",
    )?;
    let mut rows = stmt.query([chat_id])?;
    if let Some(r) = rows.next()? {
        let backend_str: String = r.get(3)?;
        Ok(Some(Chat {
            id: r.get(0)?,
            title: r.get(1)?,
            claude_session_id: r.get(2)?,
            backend: ChatBackend::from_str(&backend_str).unwrap_or(ChatBackend::Claude),
            created_at: r.get(4)?,
            last_activity_at: r.get(5)?,
        }))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_and_get_chat() {
        let db = Database::open_in_memory().unwrap();
        let id = create_chat(&db, "First chat", ChatBackend::Claude, Some("sess-abc")).unwrap();
        let chat = get_chat(&db, id).unwrap().unwrap();
        assert_eq!(chat.title, "First chat");
        assert_eq!(chat.claude_session_id.as_deref(), Some("sess-abc"));
        assert_eq!(chat.backend, ChatBackend::Claude);
    }

    #[test]
    fn list_chats_orders_by_activity_desc() {
        let db = Database::open_in_memory().unwrap();
        let a = create_chat(&db, "A", ChatBackend::Ollama, None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let b = create_chat(&db, "B", ChatBackend::Claude, Some("sess-b")).unwrap();
        let chats = list_chats(&db, 10).unwrap();
        assert_eq!(chats[0].id, b);
        assert_eq!(chats[1].id, a);
    }

    #[test]
    fn get_chat_returns_none_for_missing() {
        let db = Database::open_in_memory().unwrap();
        assert!(get_chat(&db, 9999).unwrap().is_none());
    }
}
```

**Note:** This module assumes `Database` exposes a `conn()` method returning a guard over the `rusqlite::Connection`. If it doesn't (check `db.rs` — the field may be `conn: Mutex<Connection>` used directly), adapt either by (a) adding a `pub(crate) fn conn(&self) -> MutexGuard<'_, Connection>` helper, or (b) inlining `self.conn.lock().map_err(...)?` at each call site. Keep the signatures in this task stable regardless of which path you pick — Tasks 3–5 depend on them.

- [ ] **Step 3: Run tests**

Run: `cargo test -p rewindos-core chat_store::tests`
Expected: 3 tests pass. If `Database::conn()` doesn't exist, fix per the note above.

- [ ] **Step 4: Commit**

```bash
git add crates/rewindos-core/src/chat_store.rs crates/rewindos-core/src/lib.rs
git commit -m "add chat_store with create/list/get"
```

---

## Task 3: `chat_store` — insert/list chat messages

**Files:**
- Modify: `crates/rewindos-core/src/chat_store.rs`

- [ ] **Step 1: Add append + fetch methods and tests**

Append to `crates/rewindos-core/src/chat_store.rs`:

```rust
use crate::schema::{BlockKind, ChatMessageRow, ChatRole};

pub fn append_message(
    db: &Database,
    chat_id: i64,
    role: ChatRole,
    block_type: BlockKind,
    content_json: &str,
    is_partial: bool,
) -> Result<i64> {
    let now = chrono::Local::now().timestamp();
    let conn = db.conn();
    conn.execute(
        "INSERT INTO chat_messages (chat_id, role, block_type, content_json, is_partial, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![chat_id, role.as_str(), block_type.as_str(), content_json, is_partial as i64, now],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE chats SET last_activity_at = ?1 WHERE id = ?2",
        rusqlite::params![now, chat_id],
    )?;
    Ok(id)
}

pub fn get_chat_messages(db: &Database, chat_id: i64) -> Result<Vec<ChatMessageRow>> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, chat_id, role, block_type, content_json, is_partial, created_at
         FROM chat_messages WHERE chat_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([chat_id], |r| {
        let role_str: String = r.get(2)?;
        let block_str: String = r.get(3)?;
        Ok(ChatMessageRow {
            id: r.get(0)?,
            chat_id: r.get(1)?,
            role: ChatRole::from_str(&role_str).unwrap_or(ChatRole::Assistant),
            block_type: BlockKind::from_str(&block_str).unwrap_or(BlockKind::Text),
            content_json: r.get(4)?,
            is_partial: r.get::<_, i64>(5)? != 0,
            created_at: r.get(6)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

pub fn mark_last_assistant_partial(db: &Database, chat_id: i64) -> Result<()> {
    let conn = db.conn();
    conn.execute(
        "UPDATE chat_messages SET is_partial = 1
         WHERE id = (
             SELECT id FROM chat_messages
             WHERE chat_id = ?1 AND role = 'assistant'
             ORDER BY id DESC LIMIT 1
         )",
        [chat_id],
    )?;
    Ok(())
}
```

In the `tests` module of `chat_store.rs`, append:

```rust
    #[test]
    fn append_and_read_messages() {
        let db = Database::open_in_memory().unwrap();
        let chat = create_chat(&db, "t", ChatBackend::Claude, Some("s")).unwrap();
        append_message(&db, chat, ChatRole::User, BlockKind::Text,
            r#"{"text":"hello"}"#, false).unwrap();
        append_message(&db, chat, ChatRole::Assistant, BlockKind::Text,
            r#"{"text":"hi back"}"#, false).unwrap();
        let msgs = get_chat_messages(&db, chat).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, ChatRole::User);
        assert_eq!(msgs[1].role, ChatRole::Assistant);
        assert!(msgs[1].content_json.contains("hi back"));
    }

    #[test]
    fn append_bumps_last_activity() {
        let db = Database::open_in_memory().unwrap();
        let chat = create_chat(&db, "t", ChatBackend::Ollama, None).unwrap();
        let t1 = get_chat(&db, chat).unwrap().unwrap().last_activity_at;
        std::thread::sleep(std::time::Duration::from_millis(1100));
        append_message(&db, chat, ChatRole::User, BlockKind::Text,
            r#"{"text":"x"}"#, false).unwrap();
        let t2 = get_chat(&db, chat).unwrap().unwrap().last_activity_at;
        assert!(t2 > t1, "{t2} > {t1}");
    }

    #[test]
    fn mark_last_assistant_partial_only_touches_assistant() {
        let db = Database::open_in_memory().unwrap();
        let chat = create_chat(&db, "t", ChatBackend::Claude, Some("s")).unwrap();
        append_message(&db, chat, ChatRole::User, BlockKind::Text,
            r#"{"text":"q"}"#, false).unwrap();
        append_message(&db, chat, ChatRole::Assistant, BlockKind::Text,
            r#"{"text":"part"}"#, false).unwrap();
        mark_last_assistant_partial(&db, chat).unwrap();
        let msgs = get_chat_messages(&db, chat).unwrap();
        assert!(!msgs[0].is_partial);
        assert!(msgs[1].is_partial);
    }
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p rewindos-core chat_store::tests`
Expected: 6 tests pass (3 from Task 2 + 3 from this task).

- [ ] **Step 3: Commit**

```bash
git add crates/rewindos-core/src/chat_store.rs
git commit -m "add chat_store append_message + get_chat_messages + mark_partial"
```

---

## Task 4: `chat_store` — rename, delete, FTS search

**Files:**
- Modify: `crates/rewindos-core/src/chat_store.rs`

- [ ] **Step 1: Add methods and tests**

Append to `crates/rewindos-core/src/chat_store.rs`:

```rust
pub fn rename_chat(db: &Database, chat_id: i64, title: &str) -> Result<()> {
    let conn = db.conn();
    conn.execute(
        "UPDATE chats SET title = ?1 WHERE id = ?2",
        rusqlite::params![title, chat_id],
    )?;
    Ok(())
}

pub fn delete_chat(db: &Database, chat_id: i64) -> Result<()> {
    let conn = db.conn();
    conn.execute("DELETE FROM chats WHERE id = ?1", [chat_id])?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatSearchHit {
    pub chat_id: i64,
    pub chat_title: String,
    pub message_id: i64,
    pub snippet: String,
    pub created_at: i64,
}

pub fn search_chats(db: &Database, query: &str, limit: i64) -> Result<Vec<ChatSearchHit>> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT m.chat_id, c.title, m.id,
                snippet(chat_messages_fts, 0, '<mark>', '</mark>', '…', 16),
                m.created_at
         FROM chat_messages_fts fts
         JOIN chat_messages m ON m.id = fts.rowid
         JOIN chats c ON c.id = m.chat_id
         WHERE chat_messages_fts MATCH ?1
         ORDER BY m.created_at DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![query, limit], |r| {
        Ok(ChatSearchHit {
            chat_id: r.get(0)?,
            chat_title: r.get(1)?,
            message_id: r.get(2)?,
            snippet: r.get(3)?,
            created_at: r.get(4)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}
```

In the `tests` module of `chat_store.rs`, append:

```rust
    #[test]
    fn rename_updates_title() {
        let db = Database::open_in_memory().unwrap();
        let id = create_chat(&db, "old", ChatBackend::Claude, Some("s")).unwrap();
        rename_chat(&db, id, "new").unwrap();
        assert_eq!(get_chat(&db, id).unwrap().unwrap().title, "new");
    }

    #[test]
    fn delete_cascades_messages_and_fts() {
        let db = Database::open_in_memory().unwrap();
        let id = create_chat(&db, "t", ChatBackend::Claude, Some("s")).unwrap();
        append_message(&db, id, ChatRole::User, BlockKind::Text,
            r#"{"text":"findme zxc"}"#, false).unwrap();
        delete_chat(&db, id).unwrap();
        assert!(get_chat(&db, id).unwrap().is_none());
        let hits = search_chats(&db, "zxc", 10).unwrap();
        assert_eq!(hits.len(), 0, "FTS should be cleaned up");
    }

    #[test]
    fn search_returns_text_block_snippets() {
        let db = Database::open_in_memory().unwrap();
        let id = create_chat(&db, "Claude session", ChatBackend::Claude, Some("s")).unwrap();
        append_message(&db, id, ChatRole::User, BlockKind::Text,
            r#"{"text":"what did I work on yesterday"}"#, false).unwrap();
        append_message(&db, id, ChatRole::Assistant, BlockKind::ToolUse,
            r#"{"id":"tu_1","name":"search_screenshots","input":{"query":"work"}}"#, false).unwrap();
        let hits = search_chats(&db, "yesterday", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("<mark>yesterday</mark>"));
        // tool_use should not appear in FTS
        let tu_hits = search_chats(&db, "search_screenshots", 10).unwrap();
        assert_eq!(tu_hits.len(), 0);
    }
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p rewindos-core chat_store::tests`
Expected: 9 tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/rewindos-core/src/chat_store.rs
git commit -m "add chat_store rename/delete/search_chats (FTS)"
```

---

## Task 5: Tauri chat CRUD commands + api.ts bindings

**Files:**
- Create: `src-tauri/src/chat_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/query-keys.ts`

- [ ] **Step 1: Create the commands module**

Create `src-tauri/src/chat_commands.rs`:

```rust
use rewindos_core::chat_store::{self, ChatSearchHit};
use rewindos_core::schema::{Chat, ChatBackend, ChatMessageRow};
use tauri::State;

use crate::AppState;

#[tauri::command]
pub fn list_chats(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<Chat>, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::list_chats(&db, limit.unwrap_or(100)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_chat_messages(
    state: State<'_, AppState>,
    chat_id: i64,
) -> Result<Vec<ChatMessageRow>, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::get_chat_messages(&db, chat_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_chat(
    state: State<'_, AppState>,
    title: String,
    backend: String,
    claude_session_id: Option<String>,
) -> Result<i64, String> {
    let backend_enum = ChatBackend::from_str(&backend)
        .ok_or_else(|| format!("invalid backend: {backend}"))?;
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::create_chat(&db, &title, backend_enum, claude_session_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_chat(
    state: State<'_, AppState>,
    chat_id: i64,
    title: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::rename_chat(&db, chat_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chat(state: State<'_, AppState>, chat_id: i64) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::delete_chat(&db, chat_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_chats(
    state: State<'_, AppState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<ChatSearchHit>, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::search_chats(&db, &query, limit.unwrap_or(50)).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register the module + commands**

In `src-tauri/src/lib.rs`:

```rust
mod chat_commands;
```

In the `invoke_handler`:

```rust
            chat_commands::list_chats,
            chat_commands::get_chat_messages,
            chat_commands::create_chat,
            chat_commands::rename_chat,
            chat_commands::delete_chat,
            chat_commands::search_chats,
```

- [ ] **Step 3: Expose in the frontend API**

In `src/lib/api.ts`, append:

```typescript
// -- Chat persistence --

export type ChatBackend = "claude" | "ollama";
export type ChatRole = "user" | "assistant";
export type BlockKind = "text" | "tool_use" | "tool_result" | "thinking";

export interface Chat {
  id: number;
  title: string;
  claude_session_id: string | null;
  backend: ChatBackend;
  created_at: number;
  last_activity_at: number;
}

export interface ChatMessageRow {
  id: number;
  chat_id: number;
  role: ChatRole;
  block_type: BlockKind;
  content_json: string;
  is_partial: boolean;
  created_at: number;
}

export interface ChatSearchHit {
  chat_id: number;
  chat_title: string;
  message_id: number;
  snippet: string;
  created_at: number;
}

export async function listChats(limit?: number): Promise<Chat[]> {
  return invoke("list_chats", { limit });
}

export async function getChatMessages(chatId: number): Promise<ChatMessageRow[]> {
  return invoke("get_chat_messages", { chatId });
}

export async function createChat(
  title: string,
  backend: ChatBackend,
  claudeSessionId: string | null = null,
): Promise<number> {
  return invoke("create_chat", { title, backend, claudeSessionId });
}

export async function renameChat(chatId: number, title: string): Promise<void> {
  return invoke("rename_chat", { chatId, title });
}

export async function deleteChat(chatId: number): Promise<void> {
  return invoke("delete_chat", { chatId });
}

export async function searchChats(query: string, limit = 50): Promise<ChatSearchHit[]> {
  return invoke("search_chats", { query, limit });
}
```

- [ ] **Step 4: Add query keys**

In `src/lib/query-keys.ts`, add to the `queryKeys` object:

```typescript
  chats: () => ["chats"] as const,
  chatMessages: (chatId: number) => ["chat-messages", chatId] as const,
  chatSearch: (query: string) => ["chat-search", query] as const,
```

- [ ] **Step 5: Verify**

Run:
```bash
cargo check -p rewindos
bun x tsc --noEmit -p tsconfig.json
```
Both expected clean. Then start the app and in DevTools:
```js
await window.__TAURI__.core.invoke("list_chats", { limit: 10 })
```
Expected: `[]`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/chat_commands.rs src-tauri/src/lib.rs src/lib/api.ts src/lib/query-keys.ts
git commit -m "add chat CRUD Tauri commands + api bindings"
```

---

## Task 6: `AskStreamEvent` type + claude stream parser

**Files:**
- Create: `src-tauri/src/ask_stream.rs`
- Modify: `src-tauri/src/lib.rs`

This parser reads Claude CLI's `stream-json` NDJSON output and emits typed events. Keeping the parser and tests in one module makes this task self-contained — Tauri wiring happens in Task 7.

- [ ] **Step 1: Create the module with types and parser**

Create `src-tauri/src/ask_stream.rs`:

```rust
use serde::{Deserialize, Serialize};

/// Events we emit to the frontend via a Tauri Channel. A clean discriminated
/// union — one event per content block + lifecycle signals.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AskStreamEvent {
    /// Session id returned by Claude on first event. Frontend records this
    /// on the chat row so subsequent turns can --resume it.
    SessionStarted { session_id: String },
    /// A text block landed (stream-json does full blocks, not per-token).
    Text { text: String },
    /// Claude invoked an MCP tool.
    ToolUse { id: String, name: String, input: serde_json::Value },
    /// MCP tool returned a result.
    ToolResult { tool_use_id: String, content: String, is_error: bool },
    /// Extended thinking block (only if extended thinking is on).
    Thinking { text: String },
    /// Final turn completed successfully.
    Done { total_cost_usd: Option<f64> },
    /// Fatal error (non-zero exit, parse failure, etc.).
    Error { message: String },
}

/// Parse a single NDJSON line from `claude --output-format stream-json` into
/// zero-or-more AskStreamEvents.
///
/// Claude's stream-json shape (as of 2.x):
///   { "type":"system", "subtype":"init", "session_id":"...", ... }
///   { "type":"assistant", "message":{ "content":[ <blocks> ] } }
///   { "type":"user",      "message":{ "content":[ <tool_result_blocks> ] } }
///   { "type":"result",    "subtype":"success", "total_cost_usd":..., "result":"..." }
pub fn parse_line(line: &str) -> Vec<AskStreamEvent> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return vec![];
    };
    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match ty {
        "system" => {
            if v.get("subtype").and_then(|s| s.as_str()) == Some("init") {
                if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                    return vec![AskStreamEvent::SessionStarted {
                        session_id: sid.to_string(),
                    }];
                }
            }
            vec![]
        }
        "assistant" => extract_blocks(&v, false),
        "user" => extract_blocks(&v, true),
        "result" => {
            let cost = v.get("total_cost_usd").and_then(|c| c.as_f64());
            // Some variants emit a "result" wrapping an error — surface it.
            if v.get("subtype").and_then(|s| s.as_str()) == Some("error") {
                let msg = v.get("result").and_then(|r| r.as_str()).unwrap_or("claude error");
                vec![AskStreamEvent::Error { message: msg.to_string() }]
            } else {
                vec![AskStreamEvent::Done { total_cost_usd: cost }]
            }
        }
        _ => vec![],
    }
}

fn extract_blocks(v: &serde_json::Value, is_user_role: bool) -> Vec<AskStreamEvent> {
    let blocks = v
        .pointer("/message/content")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();

    blocks
        .into_iter()
        .filter_map(|b| {
            let kind = b.get("type").and_then(|t| t.as_str())?;
            match kind {
                "text" if !is_user_role => {
                    let text = b.get("text").and_then(|t| t.as_str())?.to_string();
                    Some(AskStreamEvent::Text { text })
                }
                "thinking" if !is_user_role => {
                    let text = b.get("text").and_then(|t| t.as_str())?.to_string();
                    Some(AskStreamEvent::Thinking { text })
                }
                "tool_use" if !is_user_role => {
                    let id = b.get("id").and_then(|t| t.as_str())?.to_string();
                    let name = b.get("name").and_then(|t| t.as_str())?.to_string();
                    let input = b.get("input").cloned().unwrap_or(serde_json::Value::Null);
                    Some(AskStreamEvent::ToolUse { id, name, input })
                }
                "tool_result" if is_user_role => {
                    let tool_use_id = b.get("tool_use_id").and_then(|t| t.as_str())?.to_string();
                    let content = b
                        .get("content")
                        .and_then(|c| {
                            // content can be a string OR an array of {type:"text",text:"..."}
                            c.as_str().map(|s| s.to_string()).or_else(|| {
                                c.as_array().map(|arr| {
                                    arr.iter()
                                        .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                })
                            })
                        })
                        .unwrap_or_default();
                    let is_error = b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                    Some(AskStreamEvent::ToolResult { tool_use_id, content, is_error })
                }
                _ => None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_system_init() {
        let line = r#"{"type":"system","subtype":"init","session_id":"abc123"}"#;
        let evs = parse_line(line);
        assert!(matches!(
            evs.as_slice(),
            [AskStreamEvent::SessionStarted { session_id }] if session_id == "abc123"
        ));
    }

    #[test]
    fn parses_assistant_text() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#;
        let evs = parse_line(line);
        assert!(matches!(evs.as_slice(), [AskStreamEvent::Text { text }] if text == "hi"));
    }

    #[test]
    fn parses_assistant_tool_use() {
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"tool_use","id":"tu_1","name":"search_screenshots","input":{"query":"rust"}}
        ]}}"#;
        let evs = parse_line(line);
        match &evs[..] {
            [AskStreamEvent::ToolUse { id, name, input }] => {
                assert_eq!(id, "tu_1");
                assert_eq!(name, "search_screenshots");
                assert_eq!(input.get("query").unwrap().as_str().unwrap(), "rust");
            }
            _ => panic!("unexpected: {evs:?}"),
        }
    }

    #[test]
    fn parses_user_tool_result_string_content() {
        let line = r#"{"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"tu_1","content":"3 results"}
        ]}}"#;
        let evs = parse_line(line);
        match &evs[..] {
            [AskStreamEvent::ToolResult { tool_use_id, content, is_error }] => {
                assert_eq!(tool_use_id, "tu_1");
                assert_eq!(content, "3 results");
                assert!(!*is_error);
            }
            _ => panic!("unexpected: {evs:?}"),
        }
    }

    #[test]
    fn parses_user_tool_result_array_content() {
        let line = r#"{"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"tu_2","content":[
                {"type":"text","text":"line one"},
                {"type":"text","text":"line two"}
            ]}
        ]}}"#;
        let evs = parse_line(line);
        assert!(matches!(
            evs.as_slice(),
            [AskStreamEvent::ToolResult { content, .. }] if content == "line one\nline two"
        ));
    }

    #[test]
    fn parses_result_done() {
        let line = r#"{"type":"result","subtype":"success","total_cost_usd":0.0012,"result":"final"}"#;
        let evs = parse_line(line);
        assert!(matches!(
            evs.as_slice(),
            [AskStreamEvent::Done { total_cost_usd: Some(c) }] if (c - 0.0012).abs() < 1e-9
        ));
    }

    #[test]
    fn parses_result_error() {
        let line = r#"{"type":"result","subtype":"error","result":"rate limited"}"#;
        let evs = parse_line(line);
        assert!(matches!(
            evs.as_slice(),
            [AskStreamEvent::Error { message }] if message == "rate limited"
        ));
    }

    #[test]
    fn junk_lines_yield_nothing() {
        assert!(parse_line("not json").is_empty());
        assert!(parse_line("").is_empty());
        assert!(parse_line(r#"{"type":"unknown"}"#).is_empty());
    }
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/lib.rs`, add:
```rust
mod ask_stream;
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p rewindos ask_stream::tests`
Expected: 8 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/ask_stream.rs src-tauri/src/lib.rs
git commit -m "add AskStreamEvent type + stream-json parser"
```

---

## Task 7: Streaming `ask_claude` via Tauri Channel, persisting per event

**Files:**
- Modify: `src-tauri/src/claude_code.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`

The old blocking `ask_claude(session_id, prompt) -> String` is replaced. New signature: `ask_claude(chat_id, prompt, on_event: Channel<AskStreamEvent>) -> Result<()>`. The command reads stdout NDJSON, parses via `ask_stream::parse_line`, emits to the channel, and persists each event into `chat_messages`. On `SessionStarted`, if the chat row has no `claude_session_id`, set it so future turns `--resume`.

- [ ] **Step 1: Update the spawn helper**

In `src-tauri/src/claude_code.rs`, replace `ask_claude_spawn` with a streaming spawn:

```rust
pub async fn ask_claude_stream_spawn(
    prompt: &str,
    system_prompt: &str,
    session_id: Option<&str>,
    resume: bool,
) -> Result<tokio::process::Child, String> {
    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg(prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--append-system-prompt")
        .arg(system_prompt);

    if let Some(sid) = session_id {
        if resume {
            cmd.arg("--resume").arg(sid);
        } else {
            cmd.arg("--session-id").arg(sid);
        }
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn claude: {e}"))
}
```

Delete the old `ask_claude_spawn` fn.

- [ ] **Step 2: Rewrite the Tauri command**

In `src-tauri/src/lib.rs`, replace the existing `ask_claude` and `ask_claude_cancel` with:

```rust
use tauri::ipc::Channel;
use rewindos_core::chat_store;
use rewindos_core::schema::{BlockKind, ChatRole};
use tokio::io::{AsyncBufReadExt, BufReader};

const SYSTEM_PROMPT_FOR_CLAUDE: &str = r#"You are RewindOS, a local AI assistant with access to the user's screen capture history via MCP tools (search_screenshots, get_timeline, get_app_usage, get_screenshot_detail, get_recent_activity).

Answer directly. No preamble. No outline scaffolding. No "insight" blocks. No headers unless the answer naturally has >3 sections.

When referencing a screenshot you retrieved via a tool, include its id inline as [REF:ID]. Be specific about timestamps, app names, window titles.

If the context has no relevant data, say "I don't have enough screen history for that time period." Do not fabricate."#;

#[tauri::command]
async fn ask_claude(
    state: State<'_, AppState>,
    chat_id: i64,
    prompt: String,
    on_event: Channel<ask_stream::AskStreamEvent>,
) -> Result<(), String> {
    // Fetch chat to know whether we --resume an existing session or start new
    let (existing_session_id, _backend) = {
        let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
        let chat = chat_store::get_chat(&db, chat_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("chat {chat_id} not found"))?;
        (chat.claude_session_id.clone(), chat.backend)
    };

    // Persist the user's message immediately — crash-safe
    {
        let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
        let body = serde_json::json!({ "text": prompt }).to_string();
        chat_store::append_message(
            &db, chat_id, ChatRole::User, BlockKind::Text, &body, false,
        ).map_err(|e| e.to_string())?;
    }

    let resume = existing_session_id.is_some();
    let session_arg = existing_session_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let mut child = claude_code::ask_claude_stream_spawn(
        &prompt,
        SYSTEM_PROMPT_FOR_CLAUDE,
        Some(&session_arg),
        resume,
    ).await?;

    let pid = child.id().ok_or("no pid for claude child")?;
    {
        let mut map = state.claude_pids.lock().await;
        map.insert(chat_id.to_string(), pid);
    }

    let stdout = child.stdout.take().ok_or("no stdout from claude")?;
    let mut lines = BufReader::new(stdout).lines();

    // Captured for the stream loop
    let db_arc = state.db.clone(); // Note: requires AppState.db to be Arc<Mutex<Database>>.
                                    // If it's currently Mutex<Database>, see Step 3.

    let mut saw_session = existing_session_id.clone();

    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if line.trim().is_empty() { continue; }
        for ev in ask_stream::parse_line(&line) {
            // Persist before emitting so a crash between emit and ack doesn't lose the event
            persist_event(&db_arc, chat_id, &ev, &mut saw_session).map_err(|e| e.to_string())?;
            let _ = on_event.send(ev);
        }
    }

    // Await exit
    let status = child.wait().await.map_err(|e| e.to_string())?;

    // Cleanup pid entry
    {
        let mut map = state.claude_pids.lock().await;
        map.remove(&chat_id.to_string());
    }

    if !status.success() {
        let _ = on_event.send(ask_stream::AskStreamEvent::Error {
            message: format!("claude exited with {status}"),
        });
    }
    Ok(())
}

fn persist_event(
    db: &std::sync::Mutex<rewindos_core::db::Database>,
    chat_id: i64,
    ev: &ask_stream::AskStreamEvent,
    saw_session: &mut Option<String>,
) -> Result<(), String> {
    use rewindos_core::schema::{BlockKind, ChatRole};
    let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
    match ev {
        ask_stream::AskStreamEvent::SessionStarted { session_id } => {
            if saw_session.as_deref() != Some(session_id.as_str()) {
                db.conn().execute(
                    "UPDATE chats SET claude_session_id = ?1 WHERE id = ?2 AND claude_session_id IS NULL",
                    rusqlite::params![session_id, chat_id],
                ).map_err(|e| e.to_string())?;
                *saw_session = Some(session_id.clone());
            }
        }
        ask_stream::AskStreamEvent::Text { text } => {
            let body = serde_json::json!({ "text": text }).to_string();
            chat_store::append_message(&db, chat_id, ChatRole::Assistant, BlockKind::Text, &body, false)
                .map_err(|e| e.to_string())?;
        }
        ask_stream::AskStreamEvent::Thinking { text } => {
            let body = serde_json::json!({ "text": text }).to_string();
            chat_store::append_message(&db, chat_id, ChatRole::Assistant, BlockKind::Thinking, &body, false)
                .map_err(|e| e.to_string())?;
        }
        ask_stream::AskStreamEvent::ToolUse { id, name, input } => {
            let body = serde_json::json!({ "id": id, "name": name, "input": input }).to_string();
            chat_store::append_message(&db, chat_id, ChatRole::Assistant, BlockKind::ToolUse, &body, false)
                .map_err(|e| e.to_string())?;
        }
        ask_stream::AskStreamEvent::ToolResult { tool_use_id, content, is_error } => {
            let body = serde_json::json!({
                "tool_use_id": tool_use_id, "content": content, "is_error": is_error
            }).to_string();
            chat_store::append_message(&db, chat_id, ChatRole::User, BlockKind::ToolResult, &body, false)
                .map_err(|e| e.to_string())?;
        }
        ask_stream::AskStreamEvent::Done { .. } | ask_stream::AskStreamEvent::Error { .. } => {
            // Lifecycle events aren't persisted as messages.
        }
    }
    Ok(())
}

#[tauri::command]
async fn ask_claude_cancel(
    state: State<'_, AppState>,
    chat_id: i64,
) -> Result<(), String> {
    let pid = {
        let map = state.claude_pids.lock().await;
        map.get(&chat_id.to_string()).copied()
    };
    if let Some(pid) = pid {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
    // Mark in-flight assistant message as partial
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::mark_last_assistant_partial(&db, chat_id).map_err(|e| e.to_string())?;
    Ok(())
}
```

*Note on `AppState.db`:* `persist_event` above passes `&state.db` which is `Mutex<Database>`. Inline the lock in the stream loop if this causes lifetime issues: replace `let db_arc = state.db.clone();` with passing `&state` into `persist_event`, and change its `db` param to `&State<'_, AppState>`. The function body works either way.

- [ ] **Step 3: Update the `invoke_handler`**

In `src-tauri/src/lib.rs`, the `ask_claude` and `ask_claude_cancel` entries already exist from the earlier plan. Verify they match the new signatures (the macro generates different IPC glue for `Channel<T>` — no extra registration needed, but re-run cargo check).

- [ ] **Step 4: Add `uuid` if not present**

In `src-tauri/Cargo.toml`, confirm `uuid` is still a dependency (it was used previously). If the earlier cleanup dropped it, re-add:
```toml
uuid = { version = "1", features = ["v4"] }
```

- [ ] **Step 5: Update frontend api.ts**

In `src/lib/api.ts`, replace the existing `askClaude` / `askClaudeCancel` block with:

```typescript
import { Channel } from "@tauri-apps/api/core";

export type AskStreamEvent =
  | { type: "session_started"; session_id: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }
  | { type: "thinking"; text: string }
  | { type: "done"; total_cost_usd: number | null }
  | { type: "error"; message: string };

export async function askClaudeStream(
  chatId: number,
  prompt: string,
  onEvent: (ev: AskStreamEvent) => void,
): Promise<void> {
  const channel = new Channel<AskStreamEvent>();
  channel.onmessage = onEvent;
  return invoke("ask_claude", { chatId, prompt, onEvent: channel });
}

export async function askClaudeCancel(chatId: number): Promise<void> {
  return invoke("ask_claude_cancel", { chatId });
}
```

- [ ] **Step 6: Verify compiles**

Run: `cargo check -p rewindos && bun x tsc --noEmit -p tsconfig.json`
Both expected clean. Full end-to-end manual test happens in Task 10 after the UI is wired.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/claude_code.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src/lib/api.ts Cargo.lock
git commit -m "stream ask_claude via stream-json, persist per event, --resume on continuation"
```

---

## Task 8: AskContext rewrite — DB-backed, active chat, event handling

**Files:**
- Modify: `src/context/AskContext.tsx`

The old context held messages in `useState`. New context holds an `activeChatId`, messages come from TanStack Query against `getChatMessages`, and streaming events invalidate the query cache. Ollama still streams client-side but persists to the same DB.

- [ ] **Step 1: Rewrite `AskContext.tsx`**

Replace the entire contents of `src/context/AskContext.tsx`:

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  askClaudeCancel,
  askClaudeStream,
  buildChatContext,
  claudeDetect,
  createChat,
  getChatMessages,
  getConfig,
  type AskStreamEvent,
  type ChatMessageRow,
} from "@/lib/api";
import { ollamaChat, type OllamaMessage } from "@/lib/ollama-chat";
import { queryKeys } from "@/lib/query-keys";

interface RootConfigShape {
  chat: {
    ollama_url: string;
    model: string;
    temperature: number;
    max_history_messages: number;
  };
}

interface AskContextValue {
  activeChatId: number | null;
  messages: ChatMessageRow[];
  isStreaming: boolean;
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
  cancelStream: () => void;
  selectChat: (chatId: number | null) => void;
  startNewChat: () => void;
}

const AskContext = createContext<AskContextValue | null>(null);

export function AskProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [activeChatId, setActiveChatId] = useState<number | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { data: messages = [] } = useQuery({
    queryKey: activeChatId ? queryKeys.chatMessages(activeChatId) : ["chat-messages", "none"],
    queryFn: () => (activeChatId ? getChatMessages(activeChatId) : Promise.resolve([])),
    enabled: !!activeChatId,
  });

  const selectChat = useCallback((id: number | null) => {
    setActiveChatId(id);
    setError(null);
    abortRef.current?.abort();
  }, []);

  const startNewChat = useCallback(() => {
    setActiveChatId(null);
    setError(null);
    abortRef.current?.abort();
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (isStreaming || !text.trim()) return;
      setError(null);
      setIsStreaming(true);

      try {
        const claude = await claudeDetect();
        const useClaude = claude.available && claude.mcp_registered;

        // Ensure we have a chat row
        let chatId = activeChatId;
        if (chatId == null) {
          const title = text.slice(0, 60).trim() || "New chat";
          chatId = await createChat(title, useClaude ? "claude" : "ollama", null);
          setActiveChatId(chatId);
          qc.invalidateQueries({ queryKey: queryKeys.chats() });
        }

        if (useClaude) {
          await askClaudeStream(chatId, text, (ev) => {
            handleEvent(ev, chatId!, qc, setError);
          });
        } else {
          // Ollama: fetch context, stream client-side, persist to DB as blocks
          const ctx = await buildChatContext(text);
          const config = (await getConfig()) as unknown as RootConfigShape;

          // 1. Persist user message via create_chat side effect — already done. Log user msg:
          await persistUserMessage(chatId, text);
          qc.invalidateQueries({ queryKey: queryKeys.chatMessages(chatId) });

          const prevMessages = messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .slice(-config.chat.max_history_messages)
            .map((m) => ({
              role: m.role,
              content: parseBlockText(m.content_json, m.block_type),
            } satisfies OllamaMessage));

          const systemContent = `You are RewindOS. Answer directly. Cite with [REF:ID].\n\nCurrent time: ${new Date().toISOString()}\n\n${ctx.context}`;
          const ollamaMessages: OllamaMessage[] = [
            { role: "system", content: systemContent },
            ...prevMessages,
            { role: "user", content: text },
          ];

          abortRef.current = new AbortController();
          let accumulated = "";
          await ollamaChat({
            baseUrl: config.chat.ollama_url,
            model: config.chat.model,
            temperature: config.chat.temperature,
            messages: ollamaMessages,
            signal: abortRef.current.signal,
            onToken: (token) => {
              accumulated += token;
              // Optimistic UI update via cache patch
              qc.setQueryData<ChatMessageRow[]>(
                queryKeys.chatMessages(chatId!),
                (old = []) => {
                  const last = old[old.length - 1];
                  if (last && last.role === "assistant" && last.block_type === "text") {
                    return [
                      ...old.slice(0, -1),
                      { ...last, content_json: JSON.stringify({ text: accumulated }) },
                    ];
                  }
                  return [
                    ...old,
                    {
                      id: -Date.now(),
                      chat_id: chatId!,
                      role: "assistant",
                      block_type: "text",
                      content_json: JSON.stringify({ text: accumulated }),
                      is_partial: true,
                      created_at: Math.floor(Date.now() / 1000),
                    },
                  ];
                },
              );
            },
          });

          // Persist final assistant message and refresh
          await persistAssistantText(chatId, accumulated);
          qc.invalidateQueries({ queryKey: queryKeys.chatMessages(chatId) });
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // Leave partial
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [activeChatId, messages, isStreaming, qc],
  );

  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
    if (activeChatId != null) {
      askClaudeCancel(activeChatId).catch(() => {});
      qc.invalidateQueries({ queryKey: queryKeys.chatMessages(activeChatId) });
    }
    setIsStreaming(false);
  }, [activeChatId, qc]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const value = useMemo<AskContextValue>(
    () => ({ activeChatId, messages, isStreaming, error, sendMessage, cancelStream, selectChat, startNewChat }),
    [activeChatId, messages, isStreaming, error, sendMessage, cancelStream, selectChat, startNewChat],
  );

  return <AskContext.Provider value={value}>{children}</AskContext.Provider>;
}

function handleEvent(
  ev: AskStreamEvent,
  chatId: number,
  qc: ReturnType<typeof useQueryClient>,
  setError: (e: string | null) => void,
) {
  if (ev.type === "error") {
    setError(ev.message);
    return;
  }
  // Persistence happens in Rust; we just invalidate to re-fetch.
  qc.invalidateQueries({ queryKey: queryKeys.chatMessages(chatId) });
}

function parseBlockText(content_json: string, kind: ChatMessageRow["block_type"]): string {
  try {
    const v = JSON.parse(content_json);
    if (kind === "text" || kind === "thinking") return v.text ?? "";
    return "";
  } catch {
    return "";
  }
}

// Helpers for Ollama persistence — call Tauri commands that wrap chat_store
// (exposed in Task 5 as create_chat; user/assistant message persistence uses
// the existing append. Since chat_store::append_message is not exposed as a
// Tauri command yet, we expose a minimal `append_chat_message` command here.)
async function persistUserMessage(chatId: number, text: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("append_chat_message", {
    chatId,
    role: "user",
    blockType: "text",
    contentJson: JSON.stringify({ text }),
    isPartial: false,
  });
}

async function persistAssistantText(chatId: number, text: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("append_chat_message", {
    chatId,
    role: "assistant",
    blockType: "text",
    contentJson: JSON.stringify({ text }),
    isPartial: false,
  });
}

export function useAskChat() {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error("useAskChat must be used within AskProvider");
  return ctx;
}
```

- [ ] **Step 2: Add the `append_chat_message` Tauri command**

In `src-tauri/src/chat_commands.rs`, append:

```rust
#[tauri::command]
pub fn append_chat_message(
    state: State<'_, AppState>,
    chat_id: i64,
    role: String,
    block_type: String,
    content_json: String,
    is_partial: bool,
) -> Result<i64, String> {
    use rewindos_core::schema::{BlockKind, ChatRole};
    let role_enum = ChatRole::from_str(&role).ok_or_else(|| format!("bad role: {role}"))?;
    let block_enum = BlockKind::from_str(&block_type).ok_or_else(|| format!("bad block: {block_type}"))?;
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::append_message(&db, chat_id, role_enum, block_enum, &content_json, is_partial)
        .map_err(|e| e.to_string())
}
```

Register in `invoke_handler`:

```rust
            chat_commands::append_chat_message,
```

- [ ] **Step 3: Verify**

Run: `cargo check -p rewindos && bun x tsc --noEmit -p tsconfig.json`
Both clean.

- [ ] **Step 4: Commit**

```bash
git add src/context/AskContext.tsx src-tauri/src/chat_commands.rs src-tauri/src/lib.rs
git commit -m "rewrite AskContext for DB-backed chats + event invalidation"
```

---

## Task 9: Install ai-elements, write `toUIMessages`, build `AskMessages`

We adopt Vercel's `ai-elements` component library for message rendering. `ai-elements` is installed component-by-component via its CLI (shadcn-style: source lands in `src/components/ai-elements/`, fully owned and editable). It consumes Vercel AI SDK's stable `UIMessage` type, which is ~1-to-1 with the Anthropic content blocks we already store — so a single small `toUIMessages(rows)` function at the render boundary maps our `ChatMessageRow[]` to what ai-elements expects.

**Files:**
- Create (via installer): `src/components/ai-elements/*` — pulled in by `npx ai-elements@latest add`
- Create: `src/lib/chat-messages.ts` — `toUIMessages(rows): UIMessage[]` pure function
- Create: `src/lib/chat-messages.test.ts` — 5 unit tests
- Create: `src/features/ask/AskMessages.tsx` — ai-elements renderer
- Delete: `src/features/ask/ChatMessage.tsx` + `src/features/ask/ChatMessage.test.tsx` (obsolete)

- [ ] **Step 1: Install ai-elements components**

```bash
npx ai-elements@latest add conversation message response tool reasoning sources prompt-input actions suggestion loader
```

The installer:
- Writes component source to `src/components/ai-elements/<name>.tsx`
- Adds dependencies to `package.json` (`streamdown`, `shiki`, `ai`, friends)
- Does NOT touch existing shadcn components at `src/components/ui/`

Verify:
```bash
ls src/components/ai-elements/
```
Expected: ten tsx files (conversation, message, response, tool, reasoning, sources, prompt-input, actions, suggestion, loader).

If `npx ai-elements` fails for any reason, fall back to: `bun add ai streamdown shiki` then copy components manually from https://ai-sdk.dev/elements/ (per component, "Copy Code" button). Confirm with the user before taking this fallback — it's unlikely to be needed.

- [ ] **Step 2: Write `toUIMessages` with failing tests**

Create `src/lib/chat-messages.ts`:

```typescript
import type { UIMessage } from "ai";
import type { ChatMessageRow } from "./api";

/**
 * Map `ChatMessageRow[]` (one row per Anthropic content block) into `UIMessage[]`
 * (one message per role turn, with a parts array). ai-elements primitives consume
 * UIMessage directly.
 *
 * Rules:
 *  - Consecutive rows with the same role collapse into one UIMessage.
 *  - `thinking` blocks become `reasoning` parts.
 *  - Each assistant `tool_use` block pairs with its matching user `tool_result`
 *    (by `tool_use_id`) and emits a single `tool-<name>` part carrying
 *    `input`, `output`, and `state` so the Tool component renders the full call.
 *  - Unmatched `tool_result` rows (can happen during streaming before pairing)
 *    are dropped from the message walk — they'll appear on the next rerender
 *    after the matching tool_use has landed.
 */
export function toUIMessages(rows: ChatMessageRow[]): UIMessage[] {
  const resultByUseId = new Map<string, { content: string; isError: boolean }>();
  for (const r of rows) {
    if (r.role === "user" && r.block_type === "tool_result") {
      const body = safeParse(r.content_json);
      if (typeof body.tool_use_id === "string") {
        resultByUseId.set(body.tool_use_id, {
          content: body.content ?? "",
          isError: !!body.is_error,
        });
      }
    }
  }

  const messages: UIMessage[] = [];
  let current: UIMessage | null = null;

  for (const r of rows) {
    if (r.role === "user" && r.block_type === "tool_result") continue;

    if (!current || current.role !== r.role) {
      if (current) messages.push(current);
      current = { id: String(r.id), role: r.role as "user" | "assistant", parts: [] };
    }

    const body = safeParse(r.content_json);
    switch (r.block_type) {
      case "text":
        current.parts.push({ type: "text", text: body.text ?? "" } as UIMessage["parts"][number]);
        break;
      case "thinking":
        current.parts.push({ type: "reasoning", text: body.text ?? "" } as UIMessage["parts"][number]);
        break;
      case "tool_use": {
        const toolName = typeof body.name === "string" ? body.name : "unknown";
        const result = resultByUseId.get(body.id);
        current.parts.push({
          type: `tool-${toolName}`,
          toolCallId: body.id,
          input: body.input,
          state: result ? "output-available" : "input-available",
          output: result?.content,
          errorText: result?.isError ? result.content : undefined,
        } as UIMessage["parts"][number]);
        break;
      }
      case "tool_result":
        // handled in first pass; not reached here
        break;
    }
  }
  if (current) messages.push(current);
  return messages;
}

function safeParse(s: string): Record<string, any> {
  try { return JSON.parse(s); } catch { return {}; }
}
```

Create `src/lib/chat-messages.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { toUIMessages } from "./chat-messages";
import type { ChatMessageRow } from "./api";

function row(p: Partial<ChatMessageRow>): ChatMessageRow {
  return {
    id: 1,
    chat_id: 1,
    role: "user",
    block_type: "text",
    content_json: "{}",
    is_partial: false,
    created_at: 0,
    ...p,
  };
}

describe("toUIMessages", () => {
  it("returns empty array for no rows", () => {
    expect(toUIMessages([])).toEqual([]);
  });

  it("collapses consecutive same-role blocks into one message", () => {
    const msgs = toUIMessages([
      row({ id: 1, role: "assistant", block_type: "text", content_json: '{"text":"hi"}' }),
      row({ id: 2, role: "assistant", block_type: "text", content_json: '{"text":" there"}' }),
      row({ id: 3, role: "user", block_type: "text", content_json: '{"text":"ok"}' }),
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].parts).toHaveLength(2);
    expect(msgs[1].role).toBe("user");
  });

  it("maps thinking to reasoning", () => {
    const msgs = toUIMessages([
      row({ id: 1, role: "assistant", block_type: "thinking", content_json: '{"text":"pondering"}' }),
    ]);
    expect((msgs[0].parts[0] as any).type).toBe("reasoning");
    expect((msgs[0].parts[0] as any).text).toBe("pondering");
  });

  it("pairs tool_use with tool_result into a single tool-<name> part", () => {
    const msgs = toUIMessages([
      row({
        id: 1,
        role: "assistant",
        block_type: "tool_use",
        content_json: '{"id":"tu_1","name":"search_screenshots","input":{"query":"rust"}}',
      }),
      row({
        id: 2,
        role: "user",
        block_type: "tool_result",
        content_json: '{"tool_use_id":"tu_1","content":"3 hits"}',
      }),
      row({ id: 3, role: "assistant", block_type: "text", content_json: '{"text":"Found rust."}' }),
    ]);
    expect(msgs).toHaveLength(1); // tool_result is absorbed into the assistant message
    const parts = msgs[0].parts as any[];
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe("tool-search_screenshots");
    expect(parts[0].state).toBe("output-available");
    expect(parts[0].output).toBe("3 hits");
    expect(parts[0].input).toEqual({ query: "rust" });
    expect(parts[1].type).toBe("text");
  });

  it("emits tool part with input-available state when result has not arrived", () => {
    const msgs = toUIMessages([
      row({
        id: 1,
        role: "assistant",
        block_type: "tool_use",
        content_json: '{"id":"tu_1","name":"get_timeline","input":{"start_time":0,"end_time":1}}',
      }),
    ]);
    const part = msgs[0].parts[0] as any;
    expect(part.state).toBe("input-available");
    expect(part.output).toBeUndefined();
  });

  it("surfaces tool errors via errorText", () => {
    const msgs = toUIMessages([
      row({
        id: 1,
        role: "assistant",
        block_type: "tool_use",
        content_json: '{"id":"tu_1","name":"x","input":{}}',
      }),
      row({
        id: 2,
        role: "user",
        block_type: "tool_result",
        content_json: '{"tool_use_id":"tu_1","content":"boom","is_error":true}',
      }),
    ]);
    const part = msgs[0].parts[0] as any;
    expect(part.errorText).toBe("boom");
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun run test src/lib/chat-messages.test.ts`
Expected: 6 tests pass (5 described + empty-array).

- [ ] **Step 4: Create `AskMessages.tsx`**

Create `src/features/ask/AskMessages.tsx`:

```tsx
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Response } from "@/components/ai-elements/response";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { toUIMessages } from "@/lib/chat-messages";
import type { ChatMessageRow } from "@/lib/api";

export function AskMessages({
  rows,
}: {
  rows: ChatMessageRow[];
}) {
  const messages = toUIMessages(rows);

  return (
    <Conversation className="flex-1 min-h-0">
      <ConversationContent>
        {messages.map((m) => (
          <Message from={m.role} key={m.id}>
            <MessageContent>
              {m.parts.map((part, i) => {
                const anyPart = part as any;
                if (anyPart.type === "text") {
                  return <Response key={i}>{anyPart.text}</Response>;
                }
                if (anyPart.type === "reasoning") {
                  return (
                    <Reasoning key={i}>
                      <ReasoningTrigger />
                      <ReasoningContent>{anyPart.text}</ReasoningContent>
                    </Reasoning>
                  );
                }
                if (typeof anyPart.type === "string" && anyPart.type.startsWith("tool-")) {
                  return (
                    <Tool key={i} defaultOpen={false}>
                      <ToolHeader type={anyPart.type} state={anyPart.state} />
                      <ToolContent>
                        <ToolInput input={anyPart.input} />
                        {anyPart.output !== undefined && (
                          <ToolOutput output={anyPart.output} errorText={anyPart.errorText} />
                        )}
                      </ToolContent>
                    </Tool>
                  );
                }
                return null;
              })}
            </MessageContent>
          </Message>
        ))}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
```

*Note on ToolHeader props:* The exact prop names (`type`, `state`, `output`, `errorText`) match ai-elements' documented API for `Tool`/`ToolHeader`/`ToolInput`/`ToolOutput`. If the installer pulls a version where prop names have shifted, consult the component source that landed in `src/components/ai-elements/tool.tsx` and adjust this file to match — don't invent new prop names.

- [ ] **Step 5: Delete the obsolete ChatMessage files**

```bash
rm src/features/ask/ChatMessage.tsx src/features/ask/ChatMessage.test.tsx
```

Callers (only `AskView.tsx` today) will be updated in Task 10 to render `<AskMessages rows={messages} />` instead of mapping individual `<ChatMessage>`s.

- [ ] **Step 6: Verify**

Run:
```bash
bun x tsc --noEmit -p tsconfig.json
bun run test
```

TypeScript will show one error referencing the deleted `ChatMessage` in `AskView.tsx` — that's expected and gets fixed in Task 10. All other errors should be zero. All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/ai-elements \
        src/lib/chat-messages.ts src/lib/chat-messages.test.ts \
        src/features/ask/AskMessages.tsx \
        package.json bun.lock
git rm src/features/ask/ChatMessage.tsx src/features/ask/ChatMessage.test.tsx
git commit -m "install ai-elements, add toUIMessages + AskMessages renderer"
```

- [ ] **Step 1: TextBlock**

Create `src/features/ask/blocks/TextBlock.tsx`:

```tsx
import { cn } from "@/lib/utils";

interface TextBlockProps {
  text: string;
  isPartial: boolean;
  role: "user" | "assistant";
  onScreenshotClick?: (id: number) => void;
}

export function TextBlock({ text, isPartial, role, onScreenshotClick }: TextBlockProps) {
  const segments = splitOnRefs(text);
  return (
    <div
      className={cn(
        "font-sans text-sm leading-relaxed whitespace-pre-wrap",
        role === "user" ? "text-text-primary" : "text-text-secondary",
        isPartial && "opacity-70",
      )}
    >
      {segments.map((seg, i) =>
        seg.type === "ref" && onScreenshotClick ? (
          <button
            key={i}
            onClick={() => onScreenshotClick(seg.id)}
            className="inline-flex items-center px-1 mx-0.5 font-mono text-[11px] text-semantic border border-semantic/40 hover:bg-semantic/10 transition-all"
          >
            #{seg.id}
          </button>
        ) : (
          <span key={i}>{(seg as { text: string }).text}</span>
        ),
      )}
      {isPartial && <span className="inline-block w-1.5 h-3 ml-0.5 bg-semantic animate-pulse" />}
    </div>
  );
}

function splitOnRefs(text: string): Array<{ type: "text"; text: string } | { type: "ref"; id: number }> {
  const out: Array<{ type: "text"; text: string } | { type: "ref"; id: number }> = [];
  const re = /\[REF:(\d+)\]|\[#(\d+)\]/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > cursor) out.push({ type: "text", text: text.slice(cursor, m.index) });
    out.push({ type: "ref", id: Number(m[1] ?? m[2]) });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) out.push({ type: "text", text: text.slice(cursor) });
  return out;
}
```

- [ ] **Step 2: ToolUseBlock**

Create `src/features/ask/blocks/ToolUseBlock.tsx`:

```tsx
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ToolUseBlockProps {
  id: string;
  name: string;
  input: unknown;
}

export function ToolUseBlock({ name, input }: ToolUseBlockProps) {
  const [open, setOpen] = useState(false);
  const summary = summarizeInput(input);
  return (
    <div className="my-1.5 border border-border/50 bg-surface-raised/20">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-surface-raised/40 transition-colors"
      >
        <ChevronRight className={cn("size-3 shrink-0 text-text-muted transition-transform", open && "rotate-90")} />
        <span className="font-mono text-[11px] text-semantic">⚙ {name}</span>
        <span className="font-mono text-[11px] text-text-muted truncate">{summary}</span>
      </button>
      {open && (
        <pre className="px-2.5 pb-2 pt-1 font-mono text-[11px] text-text-secondary overflow-x-auto border-t border-border/30">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const entries = Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`);
  return entries.join(", ");
}
```

- [ ] **Step 3: ToolResultBlock**

Create `src/features/ask/blocks/ToolResultBlock.tsx`:

```tsx
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ToolResultBlockProps {
  content: string;
  isError: boolean;
}

export function ToolResultBlock({ content, isError }: ToolResultBlockProps) {
  const [open, setOpen] = useState(false);
  const firstLine = content.split("\n", 1)[0]?.slice(0, 120) ?? "";
  return (
    <div className={cn("my-1.5 border bg-surface-raised/10",
      isError ? "border-signal-error/40" : "border-border/40")}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-surface-raised/30 transition-colors"
      >
        <ChevronRight className={cn("size-3 shrink-0 text-text-muted transition-transform", open && "rotate-90")} />
        <span className={cn("font-mono text-[11px]", isError ? "text-signal-error" : "text-text-muted")}>
          ↳ {isError ? "error" : "result"}
        </span>
        <span className="font-mono text-[11px] text-text-muted/70 truncate">{firstLine}</span>
      </button>
      {open && (
        <pre className="px-2.5 pb-2 pt-1 font-mono text-[11px] text-text-secondary overflow-x-auto border-t border-border/30 max-h-60 overflow-y-auto">
          {content}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 4: ThinkingBlock**

Create `src/features/ask/blocks/ThinkingBlock.tsx`:

```tsx
import { useState } from "react";
import { ChevronRight, Brain } from "lucide-react";
import { cn } from "@/lib/utils";

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1.5 border border-border/30 bg-surface-raised/10">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-surface-raised/30 transition-colors"
      >
        <ChevronRight className={cn("size-3 shrink-0 text-text-muted transition-transform", open && "rotate-90")} />
        <Brain className="size-3 text-text-muted" />
        <span className="font-mono text-[11px] text-text-muted italic">thinking</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2 pt-1 font-sans text-[12px] text-text-muted/80 italic border-t border-border/30 whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Update ChatMessage.tsx to dispatch on block_type**

Read the current `src/features/ask/ChatMessage.tsx` first. It was written around the old `{role, content, references}` shape. Replace its body to accept a `ChatMessageRow` and dispatch:

```tsx
import type { ChatMessageRow } from "@/lib/api";
import { TextBlock } from "./blocks/TextBlock";
import { ToolUseBlock } from "./blocks/ToolUseBlock";
import { ToolResultBlock } from "./blocks/ToolResultBlock";
import { ThinkingBlock } from "./blocks/ThinkingBlock";

interface ChatMessageProps {
  message: ChatMessageRow;
  onScreenshotClick?: (id: number) => void;
}

export function ChatMessage({ message, onScreenshotClick }: ChatMessageProps) {
  const parsed = safeParse(message.content_json);
  switch (message.block_type) {
    case "text":
      return (
        <TextBlock
          text={parsed.text ?? ""}
          isPartial={message.is_partial}
          role={message.role}
          onScreenshotClick={onScreenshotClick}
        />
      );
    case "tool_use":
      return (
        <ToolUseBlock
          id={parsed.id ?? ""}
          name={parsed.name ?? "unknown"}
          input={parsed.input}
        />
      );
    case "tool_result":
      return (
        <ToolResultBlock
          content={parsed.content ?? ""}
          isError={!!parsed.is_error}
        />
      );
    case "thinking":
      return <ThinkingBlock text={parsed.text ?? ""} />;
    default:
      return null;
  }
}

function safeParse(s: string): Record<string, any> {
  try { return JSON.parse(s); } catch { return {}; }
}
```

*Note:* This change breaks any test that passed the old message shape. Check `src/features/ask/ChatMessage.test.tsx`. Update the fixtures to use `ChatMessageRow` (`id`, `chat_id`, `role`, `block_type: "text"`, `content_json: JSON.stringify({ text })`, `is_partial`, `created_at`).

- [ ] **Step 6: Verify**

Run: `bun x tsc --noEmit -p tsconfig.json && bun run test`
Both clean. Update `ChatMessage.test.tsx` fixtures if tests fail with the old shape.

- [ ] **Step 7: Commit**

```bash
git add src/features/ask/blocks src/features/ask/ChatMessage.tsx src/features/ask/ChatMessage.test.tsx
git commit -m "add block components (text/tool_use/tool_result/thinking), update ChatMessage"
```

---

## Task 10: `ChatSidebar` — list, new, select, search, rename, delete

**Files:**
- Create: `src/features/ask/ChatSidebar.tsx`
- Modify: `src/features/ask/AskView.tsx`

- [ ] **Step 1: Create ChatSidebar**

Create `src/features/ask/ChatSidebar.tsx`:

```tsx
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Pencil, Trash2, X } from "lucide-react";
import {
  deleteChat,
  listChats,
  renameChat,
  searchChats,
  type Chat,
  type ChatSearchHit,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { useAskChat } from "@/context/AskContext";

export function ChatSidebar() {
  const { activeChatId, selectChat, startNewChat } = useAskChat();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const { data: chats = [] } = useQuery<Chat[]>({
    queryKey: queryKeys.chats(),
    queryFn: () => listChats(200),
    staleTime: 5_000,
  });

  const { data: hits = [] } = useQuery<ChatSearchHit[]>({
    queryKey: queryKeys.chatSearch(query),
    queryFn: () => searchChats(query),
    enabled: query.trim().length > 1,
    staleTime: 2_000,
  });

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: number; title: string }) => renameChat(id, title),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.chats() }),
  });

  const del = useMutation({
    mutationFn: (id: number) => deleteChat(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.chats() });
      startNewChat();
    },
  });

  const displayList = useMemo(() => {
    if (query.trim().length <= 1) return chats.map((c) => ({ kind: "chat" as const, c }));
    const seen = new Set<number>();
    return hits
      .filter((h) => (seen.has(h.chat_id) ? false : (seen.add(h.chat_id), true)))
      .map((h) => ({ kind: "hit" as const, h }));
  }, [query, chats, hits]);

  return (
    <div className="w-56 shrink-0 border-r border-border/50 flex flex-col min-h-0">
      {/* New chat + search */}
      <div className="p-2 border-b border-border/50 space-y-1.5">
        <button
          onClick={startNewChat}
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 font-mono text-[11px] text-semantic border border-semantic/40 hover:bg-semantic/10 transition-all uppercase tracking-wider"
        >
          <Plus className="size-3" strokeWidth={2} />
          new chat
        </button>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search chats"
            className="w-full pl-7 pr-2 py-1.5 bg-surface-raised/30 border border-border/40 font-mono text-xs text-text-primary placeholder:text-text-muted/50 outline-none focus:border-semantic/40"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-1">
        {displayList.length === 0 && (
          <div className="px-3 py-4 font-mono text-[11px] text-text-muted/70 italic">
            {query ? "no matches" : "no chats yet"}
          </div>
        )}
        {displayList.map((item) => {
          if (item.kind === "chat") {
            const c = item.c;
            const active = activeChatId === c.id;
            const isRenaming = renamingId === c.id;
            return (
              <div
                key={c.id}
                className={cn(
                  "group px-2 py-1.5 cursor-pointer border-l-2 transition-colors",
                  active
                    ? "border-semantic bg-semantic/5"
                    : "border-transparent hover:bg-surface-raised/30",
                )}
                onClick={() => !isRenaming && selectChat(c.id)}
              >
                <div className="flex items-center gap-1">
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => {
                        rename.mutate({ id: c.id, title: renameValue || c.title });
                        setRenamingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      className="flex-1 bg-transparent border-b border-semantic/50 font-sans text-xs text-text-primary outline-none"
                    />
                  ) : (
                    <>
                      <span className="flex-1 font-sans text-xs text-text-primary truncate">{c.title}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenamingId(c.id);
                          setRenameValue(c.title);
                        }}
                        className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-text-primary"
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete "${c.title}"?`)) del.mutate(c.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-signal-error"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </>
                  )}
                </div>
                <div className="font-mono text-[10px] text-text-muted/60 mt-0.5">
                  {c.backend} · {relativeTime(c.last_activity_at)}
                </div>
              </div>
            );
          } else {
            const h = item.h;
            return (
              <div
                key={h.message_id}
                onClick={() => selectChat(h.chat_id)}
                className="px-2 py-1.5 cursor-pointer hover:bg-surface-raised/30 border-l-2 border-transparent"
              >
                <div className="font-sans text-xs text-text-primary truncate">{h.chat_title}</div>
                <div
                  className="font-mono text-[10px] text-text-muted/70 mt-0.5 line-clamp-2"
                  dangerouslySetInnerHTML={{ __html: h.snippet.replace(/<mark>/g, '<mark class="bg-semantic/20 text-semantic">') }}
                />
              </div>
            );
          }
        })}
      </div>
    </div>
  );
}

function relativeTime(ts: number): string {
  const delta = Math.floor(Date.now() / 1000) - ts;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}
```

- [ ] **Step 2: Rewrite `AskView.tsx` using ai-elements shell primitives**

Replace the current `src/features/ask/AskView.tsx` with the shell below. The textarea + send-button chrome is replaced by `<PromptInput>`, the empty state by `<Suggestions>`, the streaming indicator by `<Loader>`, and message rendering is delegated entirely to `<AskMessages>`.

```tsx
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { claudeDetect, getConfig } from "@/lib/api";
import { ollamaHealth } from "@/lib/ollama-chat";
import { useAskChat } from "@/context/AskContext";
import { AskMessages } from "./AskMessages";
import { ChatSidebar } from "./ChatSidebar";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import { Loader } from "@/components/ai-elements/loader";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";

interface AskViewProps {
  onSelectScreenshot: (id: number) => void;
}

interface ChatUrlConfig {
  chat: { ollama_url: string };
}

export function AskView({ onSelectScreenshot: _onSelectScreenshot }: AskViewProps) {
  const { messages, isStreaming, error, sendMessage, cancelStream } = useAskChat();
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { data: config } = useQuery({
    queryKey: queryKeys.config(),
    queryFn: getConfig,
  });

  const { data: ollamaOnline = false } = useQuery({
    queryKey: queryKeys.ollamaHealth(),
    queryFn: () =>
      config ? ollamaHealth((config as unknown as ChatUrlConfig).chat.ollama_url) : false,
    enabled: !!config,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: claudeStatus } = useQuery({
    queryKey: queryKeys.claudeStatus(),
    queryFn: claudeDetect,
    refetchInterval: 60_000,
  });

  const usingClaude = !!(claudeStatus?.available && claudeStatus.mcp_registered);
  const chatReady = usingClaude || ollamaOnline;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    (textOverride?: string) => {
      const msg = (textOverride ?? input).trim();
      if (!msg || isStreaming || !chatReady) return;
      void sendMessage(msg);
      setInput("");
    },
    [input, isStreaming, chatReady, sendMessage],
  );

  const onPromptSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      handleSubmit();
    },
    [handleSubmit],
  );

  return (
    <div className="flex-1 flex min-h-0">
      <ChatSidebar />
      <div className="flex-1 flex flex-col min-h-0">
        {/* Header bar */}
        <div className="flex items-center justify-between px-5 py-2 border-b border-border/50 shrink-0">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "w-1.5 h-1.5 rounded-full transition-colors",
                chatReady ? "bg-signal-success" : "bg-signal-error",
              )}
              title={
                usingClaude
                  ? "Claude Code connected"
                  : ollamaOnline
                    ? "Ollama connected"
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
          </div>
        </div>

        {/* Messages OR suggestions */}
        {messages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center min-h-0">
            <Suggestions>
              <Suggestion suggestion="what did I do in the last hour" onClick={(s) => handleSubmit(s)} />
              <Suggestion suggestion="last time I was in firefox" onClick={(s) => handleSubmit(s)} />
              <Suggestion suggestion="which apps did I use most today" onClick={(s) => handleSubmit(s)} />
            </Suggestions>
          </div>
        ) : (
          <AskMessages rows={messages} />
        )}

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="px-5 py-1 shrink-0">
            <Loader />
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mx-5 mb-2 px-3 py-2 border border-signal-error/30 bg-signal-error/5 shrink-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-signal-error uppercase tracking-wider">err</span>
              <span className="text-xs text-signal-error/80 truncate">{error}</span>
            </div>
          </div>
        )}

        {/* Input */}
        <div className="border-t border-border/50 px-5 py-3 shrink-0">
          <div className="max-w-2xl mx-auto">
            <PromptInput onSubmit={onPromptSubmit}>
              <PromptInputTextarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  !chatReady
                    ? "connect claude or start ollama to chat"
                    : isStreaming
                      ? "thinking..."
                      : "ask about your screen history"
                }
                disabled={isStreaming || !chatReady}
              />
              <PromptInputToolbar>
                <div />
                <PromptInputSubmit
                  disabled={!chatReady || (!input.trim() && !isStreaming)}
                  status={isStreaming ? "streaming" : "ready"}
                  onClick={(e) => {
                    if (isStreaming) {
                      e.preventDefault();
                      cancelStream();
                    }
                  }}
                />
              </PromptInputToolbar>
            </PromptInput>
          </div>
        </div>
      </div>
    </div>
  );
}
```

*Notes:*
- `onSelectScreenshot` is preserved in props but unused for now — ai-elements' `Response` renders markdown natively. Screenshot reference linking (`[REF:N]` chips) is a later enhancement via a custom `Response` component override (out of scope for this task).
- The `PromptInputSubmit` prop names (`status`, `disabled`, click-to-cancel while streaming) match ai-elements' documented API. If the installed version uses different prop names, consult `src/components/ai-elements/prompt-input.tsx` and adapt.

- [ ] **Step 3: Verify**

Run:
```bash
bun x tsc --noEmit -p tsconfig.json
bun run test
cargo check -p rewindos
```
All clean.

- [ ] **Step 4: Commit**

```bash
git add src/features/ask/ChatSidebar.tsx src/features/ask/AskView.tsx
git commit -m "add ChatSidebar + rewrite AskView with ai-elements shell"
```

---

## Task 11: Export chat as markdown

**Files:**
- Modify: `src-tauri/src/chat_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/features/ask/ChatSidebar.tsx`

- [ ] **Step 1: Add export command**

In `src-tauri/src/chat_commands.rs`, append:

```rust
#[tauri::command]
pub fn export_chat_markdown(
    state: State<'_, AppState>,
    chat_id: i64,
) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    let chat = chat_store::get_chat(&db, chat_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("chat {chat_id} not found"))?;
    let messages = chat_store::get_chat_messages(&db, chat_id).map_err(|e| e.to_string())?;

    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", chat.title));
    out.push_str(&format!("> {} · {} messages · started {}\n\n",
        chat.backend.as_str(),
        messages.len(),
        chrono::DateTime::from_timestamp(chat.created_at, 0)
            .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_default(),
    ));

    for m in messages {
        let body: serde_json::Value = serde_json::from_str(&m.content_json).unwrap_or_default();
        match m.block_type {
            rewindos_core::schema::BlockKind::Text => {
                let speaker = match m.role {
                    rewindos_core::schema::ChatRole::User => "**You**",
                    rewindos_core::schema::ChatRole::Assistant => "**Claude**",
                };
                out.push_str(&format!("{}: {}\n\n", speaker,
                    body.get("text").and_then(|t| t.as_str()).unwrap_or("")));
            }
            rewindos_core::schema::BlockKind::ToolUse => {
                let name = body.get("name").and_then(|n| n.as_str()).unwrap_or("?");
                let input = body.get("input").map(|i| i.to_string()).unwrap_or_default();
                out.push_str(&format!("> 🔧 `{name}({input})`\n\n"));
            }
            rewindos_core::schema::BlockKind::ToolResult => {
                let content = body.get("content").and_then(|c| c.as_str()).unwrap_or("");
                out.push_str(&format!("> ↳ ```\n> {}\n> ```\n\n",
                    content.replace('\n', "\n> ")));
            }
            rewindos_core::schema::BlockKind::Thinking => {
                let text = body.get("text").and_then(|t| t.as_str()).unwrap_or("");
                out.push_str(&format!("> 💭 _{text}_\n\n"));
            }
        }
    }
    Ok(out)
}
```

Register in `invoke_handler`:
```rust
            chat_commands::export_chat_markdown,
```

- [ ] **Step 2: Add frontend binding**

In `src/lib/api.ts`, append:
```typescript
export async function exportChatMarkdown(chatId: number): Promise<string> {
  return invoke("export_chat_markdown", { chatId });
}
```

- [ ] **Step 3: Add a download button to each chat item**

In `ChatSidebar.tsx`, next to the pencil+trash buttons add a download icon that triggers:

```tsx
import { Download } from "lucide-react";
import { exportChatMarkdown } from "@/lib/api";

// ... in the group-hover buttons area:
<button
  onClick={async (e) => {
    e.stopPropagation();
    const md = await exportChatMarkdown(c.id);
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${c.title.replace(/[^a-z0-9]/gi, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }}
  className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-semantic"
>
  <Download className="size-3" />
</button>
```

- [ ] **Step 4: Verify + commit**

```bash
cargo check -p rewindos && bun x tsc --noEmit -p tsconfig.json
git add src-tauri/src/chat_commands.rs src-tauri/src/lib.rs src/lib/api.ts src/features/ask/ChatSidebar.tsx
git commit -m "add export_chat_markdown + sidebar download button"
```

---

## Task 12: End-to-end verification

**Files:** None — manual verification only.

Prereqs: daemon running, Claude Code installed and MCP registered, Ollama running with qwen2.5:3b pulled.

- [ ] **Step 1: Claude happy path with visible tool calls**

1. Start app: `bun run tauri dev`
2. Open Ask view — sidebar visible, "new chat" button visible.
3. Type: "what did I do today"
4. Observe:
   - A new chat row appears in sidebar with the question as title
   - Assistant response streams block-by-block
   - Tool calls render as ⚙ cards (collapsible). Clicking expands to JSON.
   - Tool results render as ↳ cards (collapsible).
   - Final text appears after the tool cards.
   - `[REF:N]` or `[#N]` inline refs render as clickable chips.

- [ ] **Step 2: Ollama happy path**

1. Remove `claude` from PATH (or rename it).
2. Restart the app.
3. Type a question.
4. Observe:
   - A new chat is created with backend=ollama.
   - Text streams live into a single assistant message.
   - No tool cards (Ollama has no MCP).
   - Same rendering, same persistence.

- [ ] **Step 3: Session continuity**

1. Send a message in a Claude chat.
2. Send a follow-up like "and what about yesterday?" in the same chat.
3. Observe: Claude responds with context from the previous exchange — confirms `--resume` worked. Also verify `claude_session_id` is set on the chat row (DevTools: `await window.__TAURI__.core.invoke("list_chats", { limit: 5 })`).

- [ ] **Step 4: Cancellation**

1. Ask a long question.
2. Click "stop" mid-response.
3. Observe:
   - Stream halts immediately
   - `ps aux | grep claude` shows no lingering child
   - The in-flight assistant message shows "stopped" styling (partial)

- [ ] **Step 5: Switch chats**

1. Create chat A, exchange messages.
2. Click "new chat", create chat B with different topic.
3. Click chat A in sidebar — messages reload from DB.
4. Send another message in A — it continues the Claude session.

- [ ] **Step 6: Search**

1. In sidebar search box, type a keyword from an earlier message.
2. Observe: matching chats appear with highlighted snippet.
3. Click a result — that chat opens.

- [ ] **Step 7: Rename + delete + export**

1. Hover a chat → pencil → type new title → Enter. Title updates.
2. Hover → download → `.md` saves with the full conversation (tool calls included).
3. Hover → trash → confirm → chat disappears and active chat clears.

- [ ] **Step 8: Error recovery**

1. Stop Ollama mid-chat. Send a message. Error appears in UI.
2. Start Claude CLI subprocess that fails (e.g., missing MCP registration). Error is surfaced.
3. Neither state crashes the app.

- [ ] **Step 9: No commit** — verification checkpoint only.

---

## Self-review

**Spec coverage:**
- ✅ See Claude's thinking process → Tasks 6, 9 (ThinkingBlock + ToolUseBlock render stream-json events)
- ✅ Multiple chats → Tasks 1, 2, 5, 10 (chats table + sidebar)
- ✅ Browsing previous chats → Task 10 (sidebar + selectChat + reload messages)
- ✅ Save locally → Task 1 (SQLite, rewindos's existing DB)
- ✅ Streaming refactor of ask_claude → Task 7
- ✅ Formatting pollution fixed → Task 7 (`--append-system-prompt` + we render chrome, not Claude)
- ✅ Session continuity → Task 7 (`--resume` on second turn)
- ✅ Cancel handling → Task 7 + Task 3 (`mark_last_assistant_partial`)
- ✅ FTS search over chat history → Tasks 1, 4
- ✅ Ollama parity → Task 8 (writes to same tables)
- ✅ Export → Task 11

**Placeholder scan:** All code blocks are complete. Where I noted "adapt if `Database::conn()` method doesn't exist" (Task 2 Step 2) and "if `AppState.db` is not Arc" (Task 7 Step 2), I wrote the fallback inline — neither is a TBD. The `rusqlite` import in Task 7 Step 2 (`use rusqlite::params!` implicitly via the `rusqlite::params![...]` macro) is already used throughout the codebase; no extra import changes needed.

**Type consistency:**
- `ChatBackend` defined in Task 1, used in Tasks 2, 5, 8, 11.
- `ChatRole`, `BlockKind` defined in Task 1, used in Tasks 3, 7, 9, 11.
- `ChatMessageRow` defined in Task 1, used in Tasks 3, 5, 8, 9.
- `AskStreamEvent` Rust enum (Task 6) and TS discriminated union (Task 7 Step 5) use identical `snake_case` tags and payload shapes. Verified every variant matches.
- `chat_store` fn names used identically across Tasks 2, 3, 4, 5, 7, 11.
- `queryKeys.chats / chatMessages / chatSearch` defined in Task 5, used in Tasks 8, 10.

**Scope:** 12 tasks. Tasks 1–4 build the storage layer with passing tests. Task 5 exposes it. Tasks 6–7 are the streaming refactor (the core of the plan). Tasks 8–10 rewire the UI. Tasks 11–12 polish and verify. Each is one commit.
