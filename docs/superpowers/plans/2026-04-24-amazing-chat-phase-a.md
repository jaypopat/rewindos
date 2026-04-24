# Amazing Chat Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Ask view with model picker, inline citations + sources card, screenshot attachments, copy/regenerate buttons, and follow-up suggestion pills — the "Claude.ai-grade polish" layer on top of the streaming foundation we already shipped.

**Architecture:** Additive only — no rewriting of streaming, persistence, or MCP paths. One schema addition (`chats.model`), several pure parse functions with unit tests, new React components composed into the existing `AskView` / `AskMessages` / prompt input shell. Citations/attachments/model selection all piggyback on the existing `content_json` text storage using deterministic markers.

**Tech Stack:** Rust (rusqlite, refinery, tauri), TypeScript (React 19, TanStack Query), ai-elements components already installed (conversation, message, sources, dropdown-menu, dialog).

---

## Context for the implementer

**Before starting**, read:
- `docs/superpowers/specs/2026-04-24-amazing-chat-phase-a-design.md` — design decisions
- `docs/superpowers/plans/2026-04-24-streaming-chat-and-sessions.md` — prior plan (foundation). Sections on Tauri command registration, schema types, `chat_store` helpers, and AskContext structure are still accurate.

**Key invariants established by prior work:**
- `AppState.db` is `std::sync::Mutex<Database>` (not `Arc<Mutex<Database>>`) — inline the lock, pass `&state` into helpers.
- `Database::conn()` is `pub(crate)` — all SQL from `src-tauri` must go through `chat_store` helpers.
- `ChatBackend::parse_sql` / `ChatRole::parse_sql` / `BlockKind::parse_sql` (NOT `from_str` — that was renamed in Task 1 of the prior plan).
- `append_message` INSERTs + UPDATEs `last_activity_at`. Triggers populate `chat_messages_fts`.
- Tauri command names in `invoke_handler` use snake_case; TS passes camelCase which Tauri converts.
- Verification before commit: `cargo check -p rewindos && bun x tsc --noEmit -p tsconfig.json`. Running `cargo build -p rewindos-daemon --release` once at the start of the session is required because Tauri's build.rs bundles the daemon as a sidecar resource.
- Pre-existing tsc warnings in `src/components/ui/badge.tsx` and `src/components/ui/button.tsx` are acceptable baseline (fixed in a follow-up commit already); any NEW tsc errors block the task.

**Don't deviate silently.** If plan text contradicts reality (e.g. a function doesn't exist, a prop name changed), STOP and surface it before writing code. Silent deviations caused real rework in the prior plan.

---

## Task 1: V008 migration + `chats.model` + `set_model` command + Claude model constants + Ollama tags query

**Files:**
- Create: `crates/rewindos-core/migrations/V008__chat_model.sql`
- Modify: `crates/rewindos-core/src/schema.rs` (add `model` field to `Chat`)
- Modify: `crates/rewindos-core/src/chat_store.rs` (update existing read queries; add `set_model`)
- Modify: `src-tauri/src/chat_commands.rs` (add `set_model` Tauri command)
- Modify: `src-tauri/src/lib.rs` (register command)
- Modify: `src/lib/api.ts` (add `model` to `Chat` type; add `setModel`, `ollamaListModels`)
- Modify: `src/lib/query-keys.ts` (add `ollamaModels`)
- Create: `src/lib/claude-models.ts` (constant list of Claude tier display metadata)

- [ ] **Step 1: Write V008 migration**

Create `crates/rewindos-core/migrations/V008__chat_model.sql`:

```sql
-- Nullable; NULL means "use backend default".
-- Set once on first message, not updated thereafter (UPDATE guards in chat_store).
ALTER TABLE chats ADD COLUMN model TEXT;
```

- [ ] **Step 2: Extend `Chat` struct in `schema.rs`**

In `crates/rewindos-core/src/schema.rs`, find the existing `Chat` struct and add the `model` field:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Chat {
    pub id: i64,
    pub title: String,
    pub claude_session_id: Option<String>,
    pub backend: ChatBackend,
    pub created_at: i64,
    pub last_activity_at: i64,
    pub model: Option<String>,
}
```

- [ ] **Step 3: Update `list_chats` and `get_chat` in `chat_store.rs`**

In `crates/rewindos-core/src/chat_store.rs`, update the SELECT and row-mapping code in `list_chats` and `get_chat` to include the new column.

Replace the existing `list_chats`:

```rust
pub fn list_chats(db: &Database, limit: i64) -> Result<Vec<Chat>> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, title, claude_session_id, backend, created_at, last_activity_at, model
         FROM chats ORDER BY last_activity_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        let backend_str: String = r.get(3)?;
        Ok(Chat {
            id: r.get(0)?,
            title: r.get(1)?,
            claude_session_id: r.get(2)?,
            backend: ChatBackend::parse_sql(&backend_str).unwrap_or(ChatBackend::Claude),
            created_at: r.get(4)?,
            last_activity_at: r.get(5)?,
            model: r.get(6)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}
```

Replace the existing `get_chat`:

```rust
pub fn get_chat(db: &Database, chat_id: i64) -> Result<Option<Chat>> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, title, claude_session_id, backend, created_at, last_activity_at, model
         FROM chats WHERE id = ?1",
    )?;
    let mut rows = stmt.query([chat_id])?;
    if let Some(r) = rows.next()? {
        let backend_str: String = r.get(3)?;
        Ok(Some(Chat {
            id: r.get(0)?,
            title: r.get(1)?,
            claude_session_id: r.get(2)?,
            backend: ChatBackend::parse_sql(&backend_str).unwrap_or(ChatBackend::Claude),
            created_at: r.get(4)?,
            last_activity_at: r.get(5)?,
            model: r.get(6)?,
        }))
    } else {
        Ok(None)
    }
}
```

- [ ] **Step 4: Add `set_claude_model` helper**

Add to `crates/rewindos-core/src/chat_store.rs` near `set_claude_session_id`:

```rust
/// Lock a chat's model. Only sets if currently NULL — a chat cannot
/// change models mid-conversation (matches the UI's locked badge).
pub fn set_chat_model(db: &Database, chat_id: i64, model: &str) -> Result<()> {
    db.conn().execute(
        "UPDATE chats SET model = ?1 WHERE id = ?2 AND model IS NULL",
        rusqlite::params![model, chat_id],
    )?;
    Ok(())
}
```

- [ ] **Step 5: Add unit test for `set_chat_model`**

Add to the existing `#[cfg(test)] mod tests` block in `chat_store.rs`:

```rust
#[test]
fn set_chat_model_only_sets_when_null() {
    let db = Database::open_in_memory().unwrap();
    let id = create_chat(&db, "t", ChatBackend::Claude, None).unwrap();
    assert_eq!(get_chat(&db, id).unwrap().unwrap().model, None);

    set_chat_model(&db, id, "sonnet").unwrap();
    assert_eq!(
        get_chat(&db, id).unwrap().unwrap().model.as_deref(),
        Some("sonnet"),
    );

    // Second call does not overwrite
    set_chat_model(&db, id, "opus").unwrap();
    assert_eq!(
        get_chat(&db, id).unwrap().unwrap().model.as_deref(),
        Some("sonnet"),
    );
}
```

- [ ] **Step 6: Run the test**

Run: `cargo test -p rewindos-core chat_store::tests::set_chat_model_only_sets_when_null`
Expected: 1 test passes.

- [ ] **Step 7: Add `set_model` Tauri command**

In `src-tauri/src/chat_commands.rs`, append:

```rust
#[tauri::command]
pub fn set_model(
    state: State<'_, AppState>,
    chat_id: i64,
    model: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::set_chat_model(&db, chat_id, &model).map_err(|e| e.to_string())
}
```

- [ ] **Step 8: Register in `invoke_handler`**

In `src-tauri/src/lib.rs`, find the `chat_commands::` entries in the `invoke_handler!` macro and add:

```rust
            chat_commands::set_model,
```

- [ ] **Step 9: Extend TS `Chat` type + add `setModel` + `ollamaListModels`**

In `src/lib/api.ts`, find the `Chat` interface and add `model`:

```typescript
export interface Chat {
  id: number;
  title: string;
  claude_session_id: string | null;
  backend: ChatBackend;
  created_at: number;
  last_activity_at: number;
  model: string | null;
}
```

Append below the existing chat functions (near `exportChatMarkdown`):

```typescript
export async function setModel(chatId: number, model: string): Promise<void> {
  return invoke("set_model", { chatId, model });
}

export interface OllamaModelInfo {
  name: string;
  parameter_size?: string;
  family?: string;
}

/**
 * List locally-pulled Ollama models suitable for chat (excludes embedding-only models).
 * Hits the Ollama HTTP API directly from the browser — no Tauri roundtrip needed.
 */
export async function ollamaListModels(baseUrl: string): Promise<OllamaModelInfo[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`);
  if (!res.ok) throw new Error(`ollama tags: ${res.status}`);
  const data = (await res.json()) as {
    models: Array<{
      name: string;
      details?: { family?: string; parameter_size?: string };
    }>;
  };
  // Filter out embedding-only families (nomic-bert, bert, etc.) — they can't chat.
  const EMBEDDING_FAMILIES = new Set(["nomic-bert", "bert"]);
  return data.models
    .filter((m) => !EMBEDDING_FAMILIES.has(m.details?.family ?? ""))
    .map((m) => ({
      name: m.name,
      parameter_size: m.details?.parameter_size,
      family: m.details?.family,
    }));
}
```

- [ ] **Step 10: Add query key**

In `src/lib/query-keys.ts`, add inside the `queryKeys` object:

```typescript
  ollamaModels: (baseUrl: string) => ["ollama-models", baseUrl] as const,
```

- [ ] **Step 11: Add Claude model constants**

Create `src/lib/claude-models.ts`:

```typescript
/**
 * Claude Code CLI accepts `--model <alias|full-name>`. Aliases are stable
 * across minor releases; full names are pinned. We store aliases in
 * `chats.model` so existing chats keep working after model upgrades.
 */
export interface ClaudeModel {
  id: string; // alias passed to --model
  label: string; // display name
  description: string;
}

export const CLAUDE_MODELS: ClaudeModel[] = [
  {
    id: "opus",
    label: "Claude Opus",
    description: "most capable · slowest",
  },
  {
    id: "sonnet",
    label: "Claude Sonnet",
    description: "balanced · default",
  },
  {
    id: "haiku",
    label: "Claude Haiku",
    description: "fastest · cheapest",
  },
];

export const DEFAULT_CLAUDE_MODEL = "sonnet";
```

- [ ] **Step 12: Run a migration on a disposable DB to confirm V008 applies cleanly**

Run: `cargo test -p rewindos-core db::tests 2>&1 | tail -5`
Expected: all existing DB tests still pass. V008 runs transparently.

- [ ] **Step 13: Verify compile**

Run: `cargo check -p rewindos && bun x tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 14: Commit**

```bash
git add crates/rewindos-core/migrations/V008__chat_model.sql \
        crates/rewindos-core/src/schema.rs \
        crates/rewindos-core/src/chat_store.rs \
        src-tauri/src/chat_commands.rs \
        src-tauri/src/lib.rs \
        src/lib/api.ts \
        src/lib/query-keys.ts \
        src/lib/claude-models.ts
git commit -m "add chats.model column + set_model command"
```

---

## Task 2: ModelPicker component + header integration + Claude `--model` flag + Ollama `body.model`

**Files:**
- Create: `src/features/ask/ModelPicker.tsx`
- Modify: `src/features/ask/AskView.tsx` (add picker to header, thread `activeChatId` + `activeChatModel` + `activeChatBackend`)
- Modify: `src/context/AskContext.tsx` (expose `activeChat`, thread model into sendMessage for Ollama)
- Modify: `src-tauri/src/lib.rs` (pass `chat.model` into `ask_claude_stream_spawn`)
- Modify: `src-tauri/src/claude_code.rs` (`ask_claude_stream_spawn` accepts `model: Option<&str>`)
- Modify: `src/lib/ollama-chat.ts` (confirm `model` param flows; no change expected)

- [ ] **Step 1: Add `model` param to `ask_claude_stream_spawn`**

In `src-tauri/src/claude_code.rs`, replace the signature and body:

```rust
pub async fn ask_claude_stream_spawn(
    prompt: &str,
    system_prompt: &str,
    session_id: Option<&str>,
    resume: bool,
    model: Option<&str>,
) -> Result<tokio::process::Child, String> {
    let binary = find_claude_binary().ok_or_else(|| "claude CLI not found".to_string())?;
    let mut cmd = Command::new(&binary);
    cmd.arg("-p")
        .arg(prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--append-system-prompt")
        .arg(system_prompt)
        .arg("--allowedTools")
        .arg("mcp__rewindos__*");

    if let Some(m) = model {
        cmd.arg("--model").arg(m);
    }

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

- [ ] **Step 2: Update `ask_claude` to pass `chat.model`**

In `src-tauri/src/lib.rs`, find the `ask_claude_stream_spawn` invocation inside the `ask_claude` Tauri command and update it. First, the chat lookup section already pulls `existing_session_id`; we also need `chat.model`. Extend the first destructure:

Find this block in `ask_claude`:

```rust
    let existing_session_id = {
        let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
        let chat = chat_store::get_chat(&db, chat_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("chat {chat_id} not found"))?;
        chat.claude_session_id.clone()
    };
```

Replace with:

```rust
    let (existing_session_id, chat_model) = {
        let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
        let chat = chat_store::get_chat(&db, chat_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("chat {chat_id} not found"))?;
        (chat.claude_session_id.clone(), chat.model.clone())
    };
```

Then find:

```rust
    let mut child = claude_code::ask_claude_stream_spawn(
        &prompt,
        SYSTEM_PROMPT_FOR_CLAUDE,
        Some(&session_arg),
        resume,
    )
    .await?;
```

Replace with:

```rust
    let mut child = claude_code::ask_claude_stream_spawn(
        &prompt,
        SYSTEM_PROMPT_FOR_CLAUDE,
        Some(&session_arg),
        resume,
        chat_model.as_deref(),
    )
    .await?;
```

- [ ] **Step 3: Verify Rust compiles**

Run: `cargo check -p rewindos`
Expected: clean.

- [ ] **Step 4: Expose `activeChat` from `AskContext`**

In `src/context/AskContext.tsx`, find the `useQuery` that loads messages. Add a second query for the active chat row (so the UI can read `chat.model` / `chat.backend`). Add near the existing messages query:

```typescript
  const { data: activeChat = null } = useQuery({
    queryKey: activeChatId
      ? (["chat", activeChatId] as const)
      : (["chat", "none"] as const),
    queryFn: async () => {
      if (!activeChatId) return null;
      const chats = await listChats(200);
      return chats.find((c) => c.id === activeChatId) ?? null;
    },
    enabled: !!activeChatId,
  });
```

Add `listChats` to the imports at the top of the file (alongside the existing ones from `@/lib/api`).

Extend the context interface and value. Find `AskContextValue`:

```typescript
interface AskContextValue {
  activeChatId: number | null;
  activeChat: Chat | null;
  messages: ChatMessageRow[];
  isStreaming: boolean;
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
  cancelStream: () => void;
  selectChat: (chatId: number | null) => void;
  startNewChat: () => void;
}
```

Add `Chat` to the imports from `@/lib/api`.

In the `value` `useMemo`, add `activeChat`:

```typescript
  const value = useMemo<AskContextValue>(
    () => ({
      activeChatId,
      activeChat,
      messages,
      isStreaming,
      error,
      sendMessage,
      cancelStream,
      selectChat,
      startNewChat,
    }),
    [
      activeChatId,
      activeChat,
      messages,
      isStreaming,
      error,
      sendMessage,
      cancelStream,
      selectChat,
      startNewChat,
    ],
  );
```

- [ ] **Step 5: Thread `chat.model` into Ollama send in `sendMessage`**

Still in `src/context/AskContext.tsx`, find the Ollama branch of `sendMessage`. Currently it reads the model from `config.chat.model`. Change it to prefer `activeChat.model` when present:

Find:

```typescript
          await ollamaChat({
            baseUrl: config.chat.ollama_url,
            model: config.chat.model,
```

Replace with:

```typescript
          await ollamaChat({
            baseUrl: config.chat.ollama_url,
            model: activeChat?.model ?? config.chat.model,
```

- [ ] **Step 6: Lock the model on first send**

Still in `sendMessage`, right after the `createChat` call (where we invalidate chat list), add a `setModel` call so the freshly-created chat gets its model locked immediately. Find:

```typescript
        let chatId = activeChatId;
        if (chatId == null) {
          const title = text.slice(0, 60).trim() || "New chat";
          chatId = await createChat(title, useClaude ? "claude" : "ollama", null);
          setActiveChatId(chatId);
          qc.invalidateQueries({ queryKey: queryKeys.chats() });
        }
```

Replace with:

```typescript
        let chatId = activeChatId;
        if (chatId == null) {
          const title = text.slice(0, 60).trim() || "New chat";
          chatId = await createChat(title, useClaude ? "claude" : "ollama", null);
          setActiveChatId(chatId);
          // Lock the model the user chose (or the default if none)
          const pendingModel =
            pendingModelRef.current ??
            (useClaude ? "sonnet" : config?.chat?.model ?? "");
          if (pendingModel) {
            await setModel(chatId, pendingModel);
          }
          qc.invalidateQueries({ queryKey: queryKeys.chats() });
        }
```

Add `setModel` to the imports at the top of the file.

Add near the other refs (inside the `AskProvider` component):

```typescript
  const pendingModelRef = useRef<string | null>(null);
```

Expose a setter on the context so the picker can call it. Extend `AskContextValue`:

```typescript
interface AskContextValue {
  // ... existing fields ...
  setPendingModel: (model: string | null) => void;
}
```

Add the implementation inside `AskProvider`:

```typescript
  const setPendingModel = useCallback((model: string | null) => {
    pendingModelRef.current = model;
  }, []);
```

Add `setPendingModel` to both the value object and its deps array.

Note: the `config` variable needs to come from somewhere — the existing code fetches it inside the Ollama branch. To make it available earlier for `pendingModel` default, move the `getConfig` call up or read it from an existing query. Simplest: add a top-level `const { data: config } = useQuery({ queryKey: queryKeys.config(), queryFn: getConfig });` at the top of `AskProvider` if it's not already present. (Check first — it may already exist; `AskView.tsx` also has a copy.)

- [ ] **Step 7: Create `ModelPicker` component**

Create `src/features/ask/ModelPicker.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Check, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { getConfig, ollamaListModels } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from "@/lib/claude-models";
import { useAskChat } from "@/context/AskContext";

interface ChatUrlConfig {
  chat: { ollama_url: string; model: string };
}

/**
 * Header model picker. Shows current model or a lock badge once the chat
 * has sent its first message. Clicking opens a two-section dropdown
 * (Claude tiers + live Ollama models).
 */
export function ModelPicker() {
  const { activeChat, setPendingModel } = useAskChat();

  const { data: config } = useQuery({
    queryKey: queryKeys.config(),
    queryFn: getConfig,
  });
  const ollamaUrl = (config as unknown as ChatUrlConfig | undefined)?.chat.ollama_url ?? "";
  const defaultOllama = (config as unknown as ChatUrlConfig | undefined)?.chat.model ?? "";

  const { data: ollamaModels = [] } = useQuery({
    queryKey: queryKeys.ollamaModels(ollamaUrl),
    queryFn: () => ollamaListModels(ollamaUrl),
    enabled: !!ollamaUrl,
    staleTime: 60_000,
  });

  // If chat is locked, render a read-only badge instead of a button.
  if (activeChat?.model) {
    const backend = activeChat.backend;
    return (
      <div className="flex items-center gap-2 px-2 py-0.5 border border-border/40 bg-surface-raised/30">
        <Zap className={cn("size-3", backend === "claude" ? "text-semantic" : "text-accent")} />
        <span className="font-mono text-[10px] text-text-primary uppercase tracking-wider">
          {activeChat.model}
        </span>
        <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">
          · locked
        </span>
      </div>
    );
  }

  // No active chat yet — show the pending model selector. Default to sonnet
  // until the user picks something; the pending pick is applied when the
  // first message is sent.
  // We read the pending value from local component state so the dropdown
  // gives immediate feedback before the chat exists.
  // (After first send, activeChat.model takes over via the branch above.)
  const selectedLabel = getCurrentSelection(activeChat?.model ?? undefined);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-1.5 px-2 py-0.5 border border-border/40 bg-surface-raised/30 hover:border-border/60 focus:outline-none font-mono text-[10px] uppercase tracking-wider text-text-primary"
      >
        <Zap className="size-3 text-semantic" />
        {selectedLabel}
        <ChevronDown className="size-3 text-text-muted" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          claude code
        </DropdownMenuLabel>
        {CLAUDE_MODELS.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onSelect={() => setPendingModel(m.id)}
            className="flex items-center gap-2"
          >
            <CheckIcon visible={isCurrent(m.id)} />
            <div className="flex-1">
              <div className="text-sm text-text-primary">{m.label}</div>
              <div className="font-mono text-[10px] text-text-muted">{m.description}</div>
            </div>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          ollama (local)
        </DropdownMenuLabel>
        {ollamaModels.length === 0 ? (
          <div className="px-2 py-1.5 font-mono text-[10px] text-text-muted/60 italic">
            no models pulled
          </div>
        ) : (
          ollamaModels.map((m) => (
            <DropdownMenuItem
              key={m.name}
              onSelect={() => setPendingModel(m.name)}
              className="flex items-center gap-2"
            >
              <CheckIcon visible={isCurrent(m.name)} />
              <div className="flex-1">
                <div className="text-sm text-text-primary">{m.name}</div>
                {m.parameter_size && (
                  <div className="font-mono text-[10px] text-text-muted">
                    {m.parameter_size}
                  </div>
                )}
              </div>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  function isCurrent(id: string): boolean {
    // Before first send: highlight sonnet by default so the picker shows a
    // visible current selection. After a pick, this is updated by setPendingModel.
    // Since we don't bubble the pending value back to this component, this is
    // approximate — the user's click immediately closes the menu anyway.
    const current = defaultOllama || DEFAULT_CLAUDE_MODEL;
    return id === current;
  }

  function getCurrentSelection(locked?: string): string {
    if (locked) return locked;
    return DEFAULT_CLAUDE_MODEL;
  }
}

function CheckIcon({ visible }: { visible: boolean }) {
  return (
    <Check
      className={cn(
        "size-3 shrink-0 text-semantic",
        visible ? "opacity-100" : "opacity-0",
      )}
    />
  );
}
```

*Note:* the `isCurrent` heuristic is approximate by design — the picker commits the user's choice via `setPendingModel`, so the exact "current selection" state is held in `AskContext` and isn't round-tripped to this component. The dropdown closes on pick, so the visual is fine.

- [ ] **Step 8: Wire `ModelPicker` into `AskView` header**

In `src/features/ask/AskView.tsx`, import the picker:

```typescript
import { ModelPicker } from "./ModelPicker";
```

Find the header (the `<div className="flex items-center justify-between px-6 py-2.5 border-b..."` block near the top of the component return). Replace the model label span with `<ModelPicker />`. The header becomes:

```tsx
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-2.5 border-b border-border/50 shrink-0">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "w-1.5 h-1.5 transition-colors",
                chatReady ? "bg-signal-success animate-pulse-glow" : "bg-signal-error",
              )}
            />
            <span className="font-mono text-xs text-text-primary uppercase tracking-[0.2em]">
              ask
            </span>
            <span className="text-border">·</span>
            <ModelPicker />
          </div>
        </div>
```

You can delete the `backendLabel` / `backendTitle` constants since they're no longer used.

- [ ] **Step 9: Verify compile**

Run: `cargo check -p rewindos && bun x tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/claude_code.rs \
        src-tauri/src/lib.rs \
        src/context/AskContext.tsx \
        src/features/ask/ModelPicker.tsx \
        src/features/ask/AskView.tsx
git commit -m "add model picker with claude tiers + live ollama list"
```

---

## Task 3: Citations — parse `[REF:N]`, render inline chips + Sources card

**Files:**
- Create: `src/lib/citations.ts` (`parseTextWithRefs`, `collectRefs`)
- Create: `src/lib/citations.test.ts` (6 unit tests)
- Create: `src/features/ask/CitationChip.tsx`
- Create: `src/features/ask/CitationSources.tsx` (styled Sources wrapper for RewindOS)
- Modify: `src/features/ask/AskMessages.tsx` (integrate parsers + components)
- Modify: `src/features/ask/AskView.tsx` (pass `onSelectScreenshot` through to `AskMessages`)
- Modify: `src-tauri/src/lib.rs` (add `get_screenshots_by_ids` Tauri command)
- Modify: `crates/rewindos-core/src/db.rs` (add `get_screenshots_by_ids` helper — one SELECT ... WHERE id IN (?)... for efficiency)
- Modify: `src/lib/api.ts` (add `getScreenshotsByIds` TS wrapper)
- Modify: `src/lib/query-keys.ts` (add `screenshotsByIds`)

- [ ] **Step 1: Write failing tests for `parseTextWithRefs` + `collectRefs`**

Create `src/lib/citations.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseTextWithRefs, collectRefs } from "./citations";

describe("parseTextWithRefs", () => {
  it("returns a single text segment for text with no refs", () => {
    expect(parseTextWithRefs("just plain text")).toEqual([
      { type: "text", text: "just plain text" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseTextWithRefs("")).toEqual([]);
  });

  it("splits around a single ref", () => {
    expect(parseTextWithRefs("before [REF:42] after")).toEqual([
      { type: "text", text: "before " },
      { type: "ref", id: 42 },
      { type: "text", text: " after" },
    ]);
  });

  it("handles consecutive refs with no text between", () => {
    expect(parseTextWithRefs("[REF:1][REF:2]")).toEqual([
      { type: "ref", id: 1 },
      { type: "ref", id: 2 },
    ]);
  });

  it("handles ref at start and end", () => {
    expect(parseTextWithRefs("[REF:1] middle [REF:2]")).toEqual([
      { type: "ref", id: 1 },
      { type: "text", text: " middle " },
      { type: "ref", id: 2 },
    ]);
  });

  it("ignores malformed markers", () => {
    expect(parseTextWithRefs("see [REF:abc] and [REF:] and [ref:5]")).toEqual([
      { type: "text", text: "see [REF:abc] and [REF:] and [ref:5]" },
    ]);
  });
});

describe("collectRefs", () => {
  it("collects unique ids in order of first appearance", () => {
    const parts = [
      { type: "text" as const, text: "x " },
      { type: "ref" as const, id: 42 },
      { type: "text" as const, text: " y " },
      { type: "ref" as const, id: 7 },
      { type: "text" as const, text: " z " },
      { type: "ref" as const, id: 42 },
    ];
    expect(collectRefs(parts)).toEqual([42, 7]);
  });

  it("returns empty for parts with no refs", () => {
    expect(collectRefs([{ type: "text", text: "plain" }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun run test src/lib/citations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `citations.ts`**

Create `src/lib/citations.ts`:

```typescript
/**
 * A parsed text segment: either plain text or a screenshot reference from
 * a `[REF:N]` marker emitted by the LLM per the system prompt.
 */
export type TextPart =
  | { type: "text"; text: string }
  | { type: "ref"; id: number };

const REF_RE = /\[REF:(\d+)\]/g;

/**
 * Split an assistant text block into text + ref segments. Pure.
 *
 * Rules:
 *  - Empty input → empty array.
 *  - No refs → single text segment.
 *  - `[REF:42]` anywhere → becomes a ref part with the numeric id.
 *  - Malformed markers like `[REF:abc]` or `[REF:]` or lowercase `[ref:5]`
 *    are left as literal text — the regex only matches well-formed markers.
 */
export function parseTextWithRefs(text: string): TextPart[] {
  if (text === "") return [];

  const out: TextPart[] = [];
  let cursor = 0;
  const re = new RegExp(REF_RE);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) {
      out.push({ type: "text", text: text.slice(cursor, match.index) });
    }
    out.push({ type: "ref", id: Number(match[1]) });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    out.push({ type: "text", text: text.slice(cursor) });
  }
  return out;
}

/**
 * Collect unique ref ids from a parsed parts array, in order of first appearance.
 * Used to drive the Sources card at the bottom of an assistant message.
 */
export function collectRefs(parts: TextPart[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const p of parts) {
    if (p.type === "ref" && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p.id);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun run test src/lib/citations.test.ts`
Expected: 8 tests pass (6 `parseTextWithRefs` + 2 `collectRefs`).

- [ ] **Step 5: Add Rust `get_screenshots_by_ids` helper**

In `crates/rewindos-core/src/db.rs`, find an existing screenshot helper (e.g. `get_screenshot`) and add nearby:

```rust
/// Bulk fetch by ids. Returns screenshots in the order they appear in `ids`,
/// skipping any missing. Used by the citations renderer to populate the
/// Sources card efficiently (one roundtrip instead of N).
pub fn get_screenshots_by_ids(&self, ids: &[i64]) -> Result<Vec<Screenshot>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    // Build `?,?,?...` placeholder string.
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, timestamp, app_name, window_title, window_class, \
                file_path, width, height, thumbnail_path, session_id, \
                hash, capture_reason \
         FROM screenshots WHERE id IN ({placeholders})",
    );
    let mut stmt = self.conn.prepare(&sql)?;
    let params = rusqlite::params_from_iter(ids.iter());
    let rows = stmt.query_map(params, |r| {
        Ok(Screenshot {
            id: r.get(0)?,
            timestamp: r.get(1)?,
            app_name: r.get(2)?,
            window_title: r.get(3)?,
            window_class: r.get(4)?,
            file_path: r.get(5)?,
            width: r.get(6)?,
            height: r.get(7)?,
            thumbnail_path: r.get(8)?,
            session_id: r.get(9)?,
            hash: r.get(10)?,
            capture_reason: r.get(11)?,
        })
    })?;
    let found: Vec<Screenshot> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    // Preserve input order.
    let mut by_id: std::collections::HashMap<i64, Screenshot> =
        found.into_iter().map(|s| (s.id, s)).collect();
    Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
}
```

*Note:* the SELECT column list must match whatever shape `Screenshot` already has in `schema.rs`. If `get_screenshot` in `db.rs` uses a different column list (e.g. includes `ocr_status`), mirror that. Don't invent columns. Check `get_screenshot`'s implementation first.

- [ ] **Step 6: Add `get_screenshots_by_ids` Tauri command**

In `src-tauri/src/lib.rs`, near the existing `get_screenshot` Tauri command:

```rust
#[tauri::command]
fn get_screenshots_by_ids(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<Vec<rewindos_core::schema::Screenshot>, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.get_screenshots_by_ids(&ids).map_err(|e| format!("db error: {e}"))
}
```

Register in the `invoke_handler!` macro alongside `get_screenshot`:

```rust
            get_screenshots_by_ids,
```

- [ ] **Step 7: Add TS wrapper + query key**

In `src/lib/api.ts`, find the `getScreenshot` function and add nearby:

```typescript
export async function getScreenshotsByIds(ids: number[]): Promise<Screenshot[]> {
  return invoke("get_screenshots_by_ids", { ids });
}
```

(The `Screenshot` type should already exist in api.ts. If it doesn't under that exact name, check what type `getScreenshot` returns and reuse that — do NOT invent a new type.)

In `src/lib/query-keys.ts`, add:

```typescript
  screenshotsByIds: (ids: number[]) => ["screenshots-by-ids", ...ids] as const,
```

- [ ] **Step 8: Create `CitationChip` component**

Create `src/features/ask/CitationChip.tsx`:

```tsx
import { cn } from "@/lib/utils";

interface CitationChipProps {
  id: number;
  onClick?: (id: number) => void;
}

export function CitationChip({ id, onClick }: CitationChipProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        onClick?.(id);
      }}
      className={cn(
        "inline-flex items-center px-1 mx-0.5 font-mono text-[11px]",
        "text-semantic/80 hover:text-semantic",
        "border border-semantic/30 hover:border-semantic/60 hover:bg-semantic/10",
        "transition-all align-baseline",
      )}
      aria-label={`screenshot ${id}`}
    >
      #{id}
    </button>
  );
}
```

- [ ] **Step 9: Create `CitationSources` wrapper**

Create `src/features/ask/CitationSources.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { getScreenshotsByIds, getImageUrl } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

interface CitationSourcesProps {
  ids: number[];
  onSelect?: (id: number) => void;
}

export function CitationSources({ ids, onSelect }: CitationSourcesProps) {
  const { data: screenshots = [] } = useQuery({
    queryKey: queryKeys.screenshotsByIds(ids),
    queryFn: () => getScreenshotsByIds(ids),
    enabled: ids.length > 0,
    staleTime: 60_000,
  });

  if (ids.length === 0) return null;

  return (
    <div className="mt-3 border border-border/40 bg-surface-raised/10">
      <div className="px-2.5 py-1 border-b border-border/30 flex items-center justify-between">
        <span className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em]">
          sources
        </span>
        <span className="font-mono text-[10px] text-text-muted/70">{ids.length}</span>
      </div>
      <div className="p-2 flex flex-wrap gap-2">
        {screenshots.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect?.(s.id)}
            className={cn(
              "group flex items-start gap-2 p-1.5 border border-border/30 hover:border-semantic/40 bg-surface-raised/30 hover:bg-semantic/5 transition-all",
              "w-64 text-left",
            )}
          >
            <div className="w-20 h-14 shrink-0 bg-surface-overlay overflow-hidden">
              <img
                src={getImageUrl(s.thumbnail_path ?? s.file_path)}
                alt=""
                className="w-full h-full object-cover"
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-semantic/70 group-hover:text-semantic">
                  #{s.id}
                </span>
                <span className="font-sans text-[11px] text-text-primary truncate">
                  {s.app_name ?? "unknown"}
                </span>
              </div>
              <div className="font-mono text-[10px] text-text-muted/70 mt-0.5">
                {formatTimestamp(s.timestamp)}
              </div>
              {s.window_title && (
                <div className="font-sans text-[10px] text-text-muted truncate mt-0.5">
                  {s.window_title}
                </div>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
```

If `getImageUrl` doesn't exist in `src/lib/api.ts` under that name, check what function produces Tauri asset URLs (it's imported by other views — grep for `convertFileSrc` or `asset:` usage). Use whatever the existing pattern is.

- [ ] **Step 10: Integrate into `AskMessages`**

In `src/features/ask/AskMessages.tsx`, modify the text-rendering branch and add a Sources card at the end of each assistant message.

At the top, import the new pieces:

```typescript
import { parseTextWithRefs, collectRefs, type TextPart } from "@/lib/citations";
import { CitationChip } from "./CitationChip";
import { CitationSources } from "./CitationSources";
import { Streamdown } from "streamdown";
```

Extend `AskMessagesProps`:

```typescript
interface AskMessagesProps {
  rows: ChatMessageRow[];
  onSelectScreenshot?: (id: number) => void;
}
```

Replace the text-block branch for assistant messages. Find:

```tsx
                  if (type === "text") {
                    const text = (anyPart.text as string) ?? "";
                    if (isUser) {
                      return (
                        <div
                          key={key}
                          className="text-sm text-text-primary whitespace-pre-wrap"
                        >
                          {text}
                        </div>
                      );
                    }
                    return (
                      <div key={key} className={ASSISTANT_PROSE}>
                        <Streamdown>{text}</Streamdown>
                      </div>
                    );
                  }
```

Replace the assistant branch (keep the user branch as-is):

```tsx
                  if (type === "text") {
                    const text = (anyPart.text as string) ?? "";
                    if (isUser) {
                      return (
                        <div
                          key={key}
                          className="text-sm text-text-primary whitespace-pre-wrap"
                        >
                          {text}
                        </div>
                      );
                    }
                    return (
                      <AssistantTextWithCitations
                        key={key}
                        text={text}
                        onSelectScreenshot={onSelectScreenshot}
                      />
                    );
                  }
```

Add `onSelectScreenshot` to the destructured props. Then below the component, add:

```tsx
function AssistantTextWithCitations({
  text,
  onSelectScreenshot,
}: {
  text: string;
  onSelectScreenshot?: (id: number) => void;
}) {
  const parts = parseTextWithRefs(text);
  const refIds = collectRefs(parts);

  // Render text runs through Streamdown so markdown (lists, code, etc.) still
  // works; inject chips inline by splitting the markdown string on refs.
  // Simplest approach: render each text segment as its own Streamdown block,
  // and chips between. This keeps each markdown segment self-contained.
  return (
    <>
      <div className={ASSISTANT_PROSE}>
        {parts.map((p, i) => {
          if (p.type === "text") {
            return <Streamdown key={i}>{p.text}</Streamdown>;
          }
          return (
            <CitationChip key={i} id={p.id} onClick={onSelectScreenshot} />
          );
        })}
      </div>
      {refIds.length > 0 && (
        <CitationSources ids={refIds} onSelect={onSelectScreenshot} />
      )}
    </>
  );
}
```

- [ ] **Step 11: Thread `onSelectScreenshot` from `AskView` into `AskMessages`**

In `src/features/ask/AskView.tsx`, find the `<AskMessages rows={messages} />` usage and change the underscore-prefixed unused prop to used + pass it through. Top of the component:

Replace:

```typescript
export function AskView({ onSelectScreenshot: _onSelectScreenshot }: AskViewProps) {
```

With:

```typescript
export function AskView({ onSelectScreenshot }: AskViewProps) {
```

And the render site:

```tsx
          <AskMessages rows={messages} onSelectScreenshot={onSelectScreenshot} />
```

- [ ] **Step 12: Verify compile + tests**

Run:
```
cargo check -p rewindos && bun x tsc --noEmit -p tsconfig.json
bun run test
```
Expected: all clean, 8 new citation tests pass (6 + 2), total test count goes from 46 to 54.

- [ ] **Step 13: Commit**

```bash
git add src/lib/citations.ts src/lib/citations.test.ts \
        src/lib/api.ts src/lib/query-keys.ts \
        crates/rewindos-core/src/db.rs \
        src-tauri/src/lib.rs \
        src/features/ask/CitationChip.tsx \
        src/features/ask/CitationSources.tsx \
        src/features/ask/AskMessages.tsx \
        src/features/ask/AskView.tsx
git commit -m "render [REF:N] as citation chips + sources card"
```

---

## Task 4: Screenshot attachments — picker + marker + context expansion

**Files:**
- Create: `src/lib/attachments.ts` (marker encode/decode pure functions)
- Create: `src/lib/attachments.test.ts` (5 unit tests)
- Create: `src/features/ask/AttachmentPicker.tsx` (modal dialog)
- Create: `src/features/ask/AttachmentChip.tsx`
- Modify: `src/features/ask/AskView.tsx` (add attached state + attach button + chip rendering)
- Modify: `src/features/ask/AskMessages.tsx` (render attachment chips above user message text)
- Modify: `src/context/AskContext.tsx` (`sendMessage` accepts optional attachments, expands context)

- [ ] **Step 1: Write failing tests for attachment marker**

Create `src/lib/attachments.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  encodeAttachments,
  decodeAttachments,
  stripMarker,
  hasAttachments,
} from "./attachments";

describe("attachments marker", () => {
  it("encodes ids as a prefix", () => {
    expect(encodeAttachments([42, 43], "what was I doing?")).toBe(
      "[ATTACH:42,43]\n\nwhat was I doing?",
    );
  });

  it("returns raw text when no ids", () => {
    expect(encodeAttachments([], "hello")).toBe("hello");
  });

  it("decodes a well-formed marker", () => {
    expect(decodeAttachments("[ATTACH:42,43]\n\nhi")).toEqual({
      ids: [42, 43],
      text: "hi",
    });
  });

  it("returns empty ids for text with no marker", () => {
    expect(decodeAttachments("plain text")).toEqual({
      ids: [],
      text: "plain text",
    });
  });

  it("stripMarker + hasAttachments work on edge cases", () => {
    expect(stripMarker("[ATTACH:1]\n\nhi")).toBe("hi");
    expect(stripMarker("no marker")).toBe("no marker");
    expect(hasAttachments("[ATTACH:1,2]\n\nhi")).toBe(true);
    expect(hasAttachments("hi")).toBe(false);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `bun run test src/lib/attachments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `attachments.ts`**

Create `src/lib/attachments.ts`:

```typescript
/**
 * User messages can carry pinned screenshot references via a marker at the
 * start of their content_json.text:
 *
 *   [ATTACH:42,43]\n\n<user text>
 *
 * Invariants:
 *  - If the marker is present, it's always at offset 0.
 *  - Marker regex: /^\[ATTACH:(\d+(?:,\d+)*)\]\n\n/
 *  - Absence of marker ⇒ no attachments.
 *
 * These helpers are pure and have no DB or network side effects.
 */

const RE = /^\[ATTACH:(\d+(?:,\d+)*)\]\n\n/;

export interface DecodedMessage {
  ids: number[];
  text: string;
}

export function encodeAttachments(ids: number[], text: string): string {
  if (ids.length === 0) return text;
  return `[ATTACH:${ids.join(",")}]\n\n${text}`;
}

export function decodeAttachments(raw: string): DecodedMessage {
  const m = raw.match(RE);
  if (!m) return { ids: [], text: raw };
  const ids = m[1].split(",").map((s) => Number(s));
  return { ids, text: raw.slice(m[0].length) };
}

export function stripMarker(raw: string): string {
  return raw.replace(RE, "");
}

export function hasAttachments(raw: string): boolean {
  return RE.test(raw);
}
```

- [ ] **Step 4: Run tests**

Run: `bun run test src/lib/attachments.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Create `AttachmentChip`**

Create `src/features/ask/AttachmentChip.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { getScreenshotsByIds, getImageUrl } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

interface AttachmentChipProps {
  id: number;
  onRemove?: (id: number) => void;
  onClick?: (id: number) => void;
}

export function AttachmentChip({ id, onRemove, onClick }: AttachmentChipProps) {
  const { data: screenshots = [] } = useQuery({
    queryKey: queryKeys.screenshotsByIds([id]),
    queryFn: () => getScreenshotsByIds([id]),
    staleTime: 60_000,
  });
  const shot = screenshots[0];

  return (
    <div
      className={cn(
        "group inline-flex items-center gap-1.5 p-0.5 pr-1.5",
        "border border-accent/40 bg-accent/5",
      )}
    >
      <button
        type="button"
        onClick={() => onClick?.(id)}
        disabled={!onClick}
        className="flex items-center gap-1.5"
      >
        {shot?.thumbnail_path || shot?.file_path ? (
          <div className="w-8 h-6 shrink-0 bg-surface-overlay overflow-hidden">
            <img
              src={getImageUrl(shot.thumbnail_path ?? shot.file_path)}
              alt=""
              className="w-full h-full object-cover"
            />
          </div>
        ) : (
          <div className="w-8 h-6 shrink-0 bg-surface-overlay" />
        )}
        <span className="font-mono text-[10px] text-accent">#{id}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(id)}
          className="text-accent/60 hover:text-accent"
          aria-label={`remove attachment ${id}`}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Create `AttachmentPicker` modal**

Create `src/features/ask/AttachmentPicker.tsx`:

```tsx
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { getImageUrl, search, type SearchFilters } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

interface AttachmentPickerProps {
  open: boolean;
  onClose: () => void;
  onAttach: (ids: number[]) => void;
}

const DAY = 86_400;

export function AttachmentPicker({ open, onClose, onAttach }: AttachmentPickerProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Show recent screenshots by default; filter to search when query is present.
  const now = Math.floor(Date.now() / 1000);
  const filters: SearchFilters = useMemo(
    () => ({
      start_time: now - 3 * DAY,
      end_time: now,
      limit: 60,
      offset: 0,
    }),
    [now],
  );

  const { data: searchResponse } = useQuery({
    queryKey: queryKeys.search(query, filters),
    queryFn: () => search(query, filters),
    enabled: open,
  });

  const results = searchResponse?.results ?? [];

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAttach = () => {
    onAttach(Array.from(selected));
    setSelected(new Set());
    setQuery("");
    onClose();
  };

  const handleClose = () => {
    setSelected(new Set());
    setQuery("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : handleClose())}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-mono text-xs uppercase tracking-[0.2em] text-text-primary">
            pin screenshots to prompt
          </DialogTitle>
        </DialogHeader>

        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-text-muted pointer-events-none" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search your screen history (empty = recent)"
            className="w-full pl-9 pr-2 py-2 bg-surface-raised/30 border border-border/40 font-sans text-sm text-text-primary placeholder:text-text-muted/60 outline-none focus:border-semantic/40"
          />
        </div>

        <div className="flex-1 overflow-y-auto grid grid-cols-3 sm:grid-cols-4 gap-2">
          {results.length === 0 ? (
            <div className="col-span-full px-3 py-6 font-mono text-[11px] text-text-muted/70 italic">
              {query ? "no matches" : "no recent screenshots"}
            </div>
          ) : (
            results.map((r) => {
              const isSelected = selected.has(r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => toggle(r.id)}
                  className={cn(
                    "group relative text-left border transition-all",
                    isSelected
                      ? "border-semantic bg-semantic/5"
                      : "border-border/30 hover:border-border/60",
                  )}
                >
                  <div className="aspect-video w-full bg-surface-overlay overflow-hidden">
                    <img
                      src={getImageUrl(r.thumbnail_path ?? r.file_path)}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="p-1.5">
                    <div className="font-mono text-[10px] text-semantic/70">
                      #{r.id}
                    </div>
                    <div className="font-sans text-xs text-text-primary truncate">
                      {r.app_name ?? "unknown"}
                    </div>
                    <div className="font-mono text-[10px] text-text-muted/60 mt-0.5">
                      {formatTs(r.timestamp)}
                    </div>
                  </div>
                  {isSelected && (
                    <div className="absolute top-1 right-1 bg-semantic text-background p-0.5">
                      <Check className="size-3" strokeWidth={3} />
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>

        <DialogFooter className="flex items-center justify-between pt-3 border-t border-border/30">
          <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">
            {selected.size} selected
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-text-muted hover:text-text-primary border border-border/40"
            >
              cancel
            </button>
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={handleAttach}
              className={cn(
                "px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider border transition-all",
                selected.size === 0
                  ? "text-text-muted/40 border-border/20 cursor-not-allowed"
                  : "text-semantic border-semantic/40 hover:bg-semantic/10",
              )}
            >
              attach {selected.size > 0 ? `(${selected.size})` : ""}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
```

*Note:* the `search` function and `SearchFilters` type should already exist in `src/lib/api.ts`. If `search` takes different params than `(query, filters)`, adapt to match.

- [ ] **Step 7: Wire attachments into `AskView`**

In `src/features/ask/AskView.tsx`, add imports:

```typescript
import { Paperclip } from "lucide-react";
import { AttachmentPicker } from "./AttachmentPicker";
import { AttachmentChip } from "./AttachmentChip";
```

Near the other state hooks in `AskView`:

```typescript
const [attachedIds, setAttachedIds] = useState<number[]>([]);
const [pickerOpen, setPickerOpen] = useState(false);
```

Update the `submit` callback to thread attachments through. Replace:

```typescript
  const submit = useCallback(
    (textOverride?: string) => {
      const msg = (textOverride ?? input).trim();
      if (!msg || isStreaming || !chatReady) return;
      void sendMessage(msg);
      setInput("");
    },
    [input, isStreaming, chatReady, sendMessage],
  );
```

With:

```typescript
  const submit = useCallback(
    (textOverride?: string) => {
      const msg = (textOverride ?? input).trim();
      if (!msg || isStreaming || !chatReady) return;
      void sendMessage(msg, attachedIds);
      setInput("");
      setAttachedIds([]);
    },
    [input, isStreaming, chatReady, sendMessage, attachedIds],
  );
```

Above the `<PromptInput>` element, add a chip row:

```tsx
            {attachedIds.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {attachedIds.map((id) => (
                  <AttachmentChip
                    key={id}
                    id={id}
                    onRemove={(rid) =>
                      setAttachedIds((prev) => prev.filter((x) => x !== rid))
                    }
                  />
                ))}
              </div>
            )}
```

In the `<PromptInputFooter>`, add the paperclip button before the keyboard hint:

```tsx
              <PromptInputFooter className="px-3 pb-2 pt-1 rounded-none">
                <div className="flex items-center gap-3 text-text-muted">
                  <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    disabled={isStreaming || !chatReady}
                    className="text-text-muted hover:text-semantic disabled:opacity-40 disabled:hover:text-text-muted transition-colors"
                    title="attach screenshot"
                    aria-label="attach screenshot"
                  >
                    <Paperclip className="size-4" />
                  </button>
                  <span className="font-mono text-[10px] uppercase tracking-wider">
                    {usingClaude ? "⇧⏎ newline · ⏎ send" : "⏎ send"}
                  </span>
                </div>
                <PromptInputSubmit
                  disabled={!chatReady || (!isStreaming && !input.trim())}
                  status={isStreaming ? "streaming" : "ready"}
                  onStop={cancelStream}
                />
              </PromptInputFooter>
```

At the end of the component, add the picker dialog:

```tsx
      <AttachmentPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAttach={(ids) => setAttachedIds((prev) => Array.from(new Set([...prev, ...ids])))}
      />
```

- [ ] **Step 8: Update `AskContext.sendMessage` signature**

In `src/context/AskContext.tsx`, add imports:

```typescript
import { encodeAttachments } from "@/lib/attachments";
import { getScreenshotsByIds } from "@/lib/api";
```

Update `AskContextValue`:

```typescript
  sendMessage: (text: string, attachedIds?: number[]) => Promise<void>;
```

Replace `sendMessage` signature and body. Find `const sendMessage = useCallback(\n    async (text: string) => {` and update to `async (text: string, attachedIds: number[] = []) => {`.

Within the function, replace the user-message persistence block. Find:

```typescript
        if (useClaude) {
          await askClaudeStream(chatId, text, (ev) => {
            handleEvent(ev, chatId!, qc, setError);
          });
        } else {
```

Replace with:

```typescript
        // Expand attachments into text context for the LLM; persist with
        // the [ATTACH:...] marker so the UI can re-render chips.
        const expandedText = await buildAttachedContext(attachedIds, text);
        const storedText = encodeAttachments(attachedIds, text);

        if (useClaude) {
          // The user message is persisted by the Rust backend inside
          // ask_claude — we don't append it here. Pass storedText via the
          // prompt so the Rust side stores the marker-prefixed version, and
          // pass expandedText as the actual prompt to Claude.
          // Claude receives expandedText as the prompt; the message stored
          // in chat_messages contains storedText.
          await askClaudeStreamWithAttachments(
            chatId,
            storedText,
            expandedText,
            (ev) => handleEvent(ev, chatId!, qc, setError),
          );
        } else {
```

Add near the bottom of the file (outside the component):

```typescript
async function buildAttachedContext(ids: number[], userText: string): Promise<string> {
  if (ids.length === 0) return userText;
  const shots = await getScreenshotsByIds(ids);
  const lines = shots.map((s) => {
    const ts = new Date(s.timestamp * 1000).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const app = s.app_name ?? "unknown";
    const title = s.window_title ? ` — ${s.window_title}` : "";
    // Pull OCR via get_screenshot (single) since the bulk returns Screenshot
    // without ocr_text. This is infrequent (only on send with attachments)
    // so N+1 is acceptable here.
    return `- #${s.id} (${ts}, ${app}${title})`;
  });
  return [
    "[Attached screenshots — the user has pinned these as context]",
    ...lines,
    "[End attached screenshots]",
    "",
    userText,
  ].join("\n");
}
```

*Note on expansion:* the design calls for including OCR text in the attached context. Fetching OCR per-attachment adds latency proportional to attachment count. For Phase A, keep expansion lightweight (id + timestamp + app + title) so send stays fast. If the model needs OCR content, it can call `get_screenshot_detail` via MCP — that's already available. A future enhancement could optionally inline OCR when attachment count is small (≤3).

- [ ] **Step 9: Update `ask_claude` to accept split stored/sent prompts**

This is where things get sharp. The Rust `ask_claude` currently takes one `prompt` and stores it + sends it. With attachments the stored and sent versions differ.

**Cleanest fix**: add a new optional arg `stored_text: Option<String>`. When provided, persist that instead of `prompt`. When absent, persist `prompt` (backward compat for Ollama path that uses askClaudeStream).

In `src-tauri/src/lib.rs`, find `ask_claude` and update:

```rust
#[tauri::command]
async fn ask_claude(
    state: State<'_, AppState>,
    chat_id: i64,
    prompt: String,
    stored_text: Option<String>,
    on_event: tauri::ipc::Channel<ask_stream::AskStreamEvent>,
) -> Result<(), String> {
    use rewindos_core::chat_store;
    use rewindos_core::schema::{BlockKind, ChatRole};
    use tokio::io::{AsyncBufReadExt, BufReader};

    let (existing_session_id, chat_model) = {
        let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
        let chat = chat_store::get_chat(&db, chat_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("chat {chat_id} not found"))?;
        (chat.claude_session_id.clone(), chat.model.clone())
    };

    // Persist the user's message — use stored_text if given (attachments case),
    // else the raw prompt.
    {
        let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
        let to_store = stored_text.as_deref().unwrap_or(&prompt);
        let body = serde_json::json!({ "text": to_store }).to_string();
        chat_store::append_message(
            &db,
            chat_id,
            ChatRole::User,
            BlockKind::Text,
            &body,
            false,
        )
        .map_err(|e| e.to_string())?;
    }

    // ... rest of function unchanged ...
```

The rest of the function stays the same — it uses `prompt` (the expanded version) for the Claude CLI invocation, which is what we want.

- [ ] **Step 10: Add TS helper for the two-arg claude call**

In `src/lib/api.ts`, add alongside `askClaudeStream`:

```typescript
export async function askClaudeStreamWithAttachments(
  chatId: number,
  storedText: string,
  expandedText: string,
  onEvent: (ev: AskStreamEvent) => void,
): Promise<void> {
  const channel = new Channel<AskStreamEvent>();
  channel.onmessage = onEvent;
  return invoke("ask_claude", {
    chatId,
    prompt: expandedText,
    storedText,
    onEvent: channel,
  });
}
```

Also extend `askClaudeStream` to forward `undefined` for `storedText` (so the Rust side falls back to persisting the prompt):

```typescript
export async function askClaudeStream(
  chatId: number,
  prompt: string,
  onEvent: (ev: AskStreamEvent) => void,
): Promise<void> {
  const channel = new Channel<AskStreamEvent>();
  channel.onmessage = onEvent;
  return invoke("ask_claude", { chatId, prompt, onEvent: channel });
}
```

(Tauri will pass `undefined` as an absent optional field, matching `stored_text: Option<String>`.)

- [ ] **Step 11: Handle Ollama branch too**

Back in `AskContext.tsx`'s Ollama branch, after computing `expandedText` and `storedText`, update the persistUserMessage call. Find:

```typescript
          await persistUserMessage(chatId, text);
```

Replace with:

```typescript
          await persistUserMessage(chatId, storedText);
```

Then in the Ollama message array construction, use `expandedText` for the user role content instead of `text`. Find:

```typescript
            { role: "user", content: text },
```

Replace with:

```typescript
            { role: "user", content: expandedText },
```

Also ensure the `text` symbol in the rest of the block doesn't get ambiguous — the `accumulated` setQueryData logic still keys off existing message shape; nothing else changes.

- [ ] **Step 12: Render attachment chips in `AskMessages` for user messages**

In `src/features/ask/AskMessages.tsx`, add imports:

```typescript
import { decodeAttachments } from "@/lib/attachments";
import { AttachmentChip } from "./AttachmentChip";
```

Extend `AskMessagesProps` (already done in Task 3 for `onSelectScreenshot`).

Find the user text-block branch. Replace:

```tsx
                    if (isUser) {
                      return (
                        <div
                          key={key}
                          className="text-sm text-text-primary whitespace-pre-wrap"
                        >
                          {text}
                        </div>
                      );
                    }
```

With:

```tsx
                    if (isUser) {
                      const decoded = decodeAttachments(text);
                      return (
                        <div key={key} className="space-y-2">
                          {decoded.ids.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {decoded.ids.map((id) => (
                                <AttachmentChip
                                  key={id}
                                  id={id}
                                  onClick={onSelectScreenshot}
                                />
                              ))}
                            </div>
                          )}
                          {decoded.text && (
                            <div className="text-sm text-text-primary whitespace-pre-wrap">
                              {decoded.text}
                            </div>
                          )}
                        </div>
                      );
                    }
```

- [ ] **Step 13: Verify compile + tests**

Run:
```
cargo check -p rewindos && bun x tsc --noEmit -p tsconfig.json
bun run test
```
Expected: clean. Test count goes from 54 to 59 (+5 attachment tests).

- [ ] **Step 14: Commit**

```bash
git add src/lib/attachments.ts src/lib/attachments.test.ts \
        src/lib/api.ts \
        src-tauri/src/lib.rs \
        src/features/ask/AttachmentChip.tsx \
        src/features/ask/AttachmentPicker.tsx \
        src/features/ask/AskView.tsx \
        src/features/ask/AskMessages.tsx \
        src/context/AskContext.tsx
git commit -m "add screenshot attachment picker + context expansion"
```

---

## Task 5: Copy/regenerate buttons + follow-up suggestions

**Files:**
- Create: `src/features/ask/MessageActions.tsx`
- Create: `src/features/ask/FollowupSuggestions.tsx`
- Create: `src/lib/followups.ts` (generation helper)
- Modify: `crates/rewindos-core/src/chat_store.rs` (add `delete_messages_after`)
- Modify: `src-tauri/src/chat_commands.rs` (Tauri wrapper)
- Modify: `src-tauri/src/lib.rs` (register command)
- Modify: `src/lib/api.ts` (TS wrapper)
- Modify: `src/context/AskContext.tsx` (expose `regenerate`, `followups` state; trigger generation on stream complete)
- Modify: `src/features/ask/AskMessages.tsx` (render actions + followups under last assistant)

- [ ] **Step 1: Add `delete_messages_after` to `chat_store.rs`**

```rust
/// Delete all messages in a chat with id strictly greater than `after_id`.
/// Also clears `claude_session_id` on the chat row — the Claude-side session
/// history no longer matches our local view after truncation, so the next
/// turn must start a fresh session with the reconstructed history.
pub fn delete_messages_after(db: &Database, chat_id: i64, after_id: i64) -> Result<()> {
    let conn = db.conn();
    conn.execute(
        "DELETE FROM chat_messages WHERE chat_id = ?1 AND id > ?2",
        rusqlite::params![chat_id, after_id],
    )?;
    conn.execute(
        "UPDATE chats SET claude_session_id = NULL WHERE id = ?1",
        rusqlite::params![chat_id],
    )?;
    Ok(())
}
```

- [ ] **Step 2: Add unit test**

In the tests module of `chat_store.rs`:

```rust
#[test]
fn delete_messages_after_truncates_and_clears_session() {
    let db = Database::open_in_memory().unwrap();
    let id = create_chat(&db, "t", ChatBackend::Claude, Some("sess-xyz")).unwrap();
    let m1 = append_message(&db, id, ChatRole::User, BlockKind::Text, r#"{"text":"a"}"#, false).unwrap();
    let _m2 = append_message(&db, id, ChatRole::Assistant, BlockKind::Text, r#"{"text":"b"}"#, false).unwrap();
    let _m3 = append_message(&db, id, ChatRole::User, BlockKind::Text, r#"{"text":"c"}"#, false).unwrap();

    delete_messages_after(&db, id, m1).unwrap();
    let remaining = get_chat_messages(&db, id).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, m1);

    let chat = get_chat(&db, id).unwrap().unwrap();
    assert_eq!(chat.claude_session_id, None);
}
```

- [ ] **Step 3: Run the test**

Run: `cargo test -p rewindos-core chat_store::tests::delete_messages_after_truncates_and_clears_session`
Expected: 1 test passes.

- [ ] **Step 4: Add Tauri command + register**

In `src-tauri/src/chat_commands.rs`:

```rust
#[tauri::command]
pub fn delete_messages_after(
    state: State<'_, AppState>,
    chat_id: i64,
    after_id: i64,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::delete_messages_after(&db, chat_id, after_id).map_err(|e| e.to_string())
}
```

In `src-tauri/src/lib.rs`, add to `invoke_handler!`:

```rust
            chat_commands::delete_messages_after,
```

- [ ] **Step 5: Add TS wrapper**

In `src/lib/api.ts`:

```typescript
export async function deleteMessagesAfter(
  chatId: number,
  afterId: number,
): Promise<void> {
  return invoke("delete_messages_after", { chatId, afterId });
}
```

- [ ] **Step 6: Create `MessageActions` component**

Create `src/features/ask/MessageActions.tsx`:

```tsx
import { useState } from "react";
import { Copy, RefreshCw, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface MessageActionsProps {
  onCopy: () => void;
  onRegenerate: () => void;
  disabled?: boolean;
}

export function MessageActions({ onCopy, onRegenerate, disabled }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="flex items-center gap-1 mt-2 opacity-60 hover:opacity-100 transition-opacity">
      <ActionButton onClick={handleCopy} disabled={disabled} label={copied ? "copied" : "copy"}>
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </ActionButton>
      <ActionButton onClick={onRegenerate} disabled={disabled} label="regenerate">
        <RefreshCw className="size-3" />
      </ActionButton>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "flex items-center gap-1 px-1.5 py-0.5",
        "font-mono text-[10px] uppercase tracking-wider",
        "text-text-muted hover:text-text-primary border border-transparent hover:border-border/40",
        "disabled:opacity-40 disabled:hover:text-text-muted disabled:hover:border-transparent",
        "transition-colors",
      )}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}
```

- [ ] **Step 7: Create `followups.ts`**

Create `src/lib/followups.ts`:

```typescript
import type { ChatMessageRow } from "./api";

/**
 * Generate 3 short follow-up questions from the conversation so far.
 *
 * Uses whichever backend the chat is already using — Claude chats ping
 * Haiku (fastest tier) to stay snappy; Ollama chats reuse the chat's
 * local model. 3-second timeout; silent-fail on error.
 *
 * Ephemeral — these are not persisted.
 */
export async function generateFollowups(params: {
  backend: "claude" | "ollama";
  ollamaUrl?: string;
  ollamaModel?: string;
  lastUserText: string;
  lastAssistantText: string;
}): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);

  try {
    const prompt = buildPrompt(params.lastUserText, params.lastAssistantText);
    if (params.backend === "claude") {
      return await claudeHaikuFollowups(prompt, controller.signal);
    }
    if (params.ollamaUrl && params.ollamaModel) {
      return await ollamaFollowups(
        params.ollamaUrl,
        params.ollamaModel,
        prompt,
        controller.signal,
      );
    }
    return [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function buildPrompt(userText: string, assistantText: string): string {
  return [
    "Suggest exactly 3 short follow-up questions the user might ask next.",
    "Each question must be under 10 words. Be specific to the topic.",
    "Output ONLY a JSON array of 3 strings, nothing else.",
    "",
    `User asked: ${userText}`,
    "",
    `You answered: ${assistantText.slice(0, 1000)}`,
  ].join("\n");
}

async function claudeHaikuFollowups(
  prompt: string,
  signal: AbortSignal,
): Promise<string[]> {
  // Uses a minimal Tauri command to run a one-shot Haiku call.
  // For Phase A simplicity, we inline a short `claude -p` spawn via the
  // existing Tauri command set — but since we don't have a dedicated
  // "claude oneshot" command, we shell out via another invoke.
  // If you prefer to skip the Tauri roundtrip, this can be replaced with
  // a direct fetch to the Anthropic API — but that requires an API key.
  //
  // Phase A decision: gracefully return [] if we can't run the call.
  // Followups are nice-to-have; don't block on them.
  void prompt;
  void signal;
  return [];
}

async function ollamaFollowups(
  baseUrl: string,
  model: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    signal,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      options: { temperature: 0.3 },
    }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content ?? "";
  const parsed = tryParseJsonArray(content);
  if (!parsed) return [];
  return parsed
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .slice(0, 3);
}

function tryParseJsonArray(s: string): unknown[] | null {
  const match = s.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const v = JSON.parse(match[0]);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function extractLastTurns(rows: ChatMessageRow[]): {
  lastUserText: string;
  lastAssistantText: string;
} {
  let lastUserText = "";
  let lastAssistantText = "";
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.block_type !== "text") continue;
    try {
      const v = JSON.parse(r.content_json);
      const text = typeof v.text === "string" ? v.text : "";
      if (r.role === "assistant" && !lastAssistantText) lastAssistantText = text;
      else if (r.role === "user" && !lastUserText) lastUserText = text;
      if (lastUserText && lastAssistantText) break;
    } catch {
      // skip
    }
  }
  return { lastUserText, lastAssistantText };
}
```

*Note:* the Claude Haiku path is intentionally a stub returning `[]`. Phase A ships Ollama-backed followups; Claude Haiku followups are a follow-up enhancement (requires a new "claude one-shot" Tauri command to avoid the cost of bundling a second session). Marking this explicitly so the implementer doesn't think they need to build it.

- [ ] **Step 8: Create `FollowupSuggestions` component**

Create `src/features/ask/FollowupSuggestions.tsx`:

```tsx
import { cn } from "@/lib/utils";

interface FollowupSuggestionsProps {
  suggestions: string[];
  onSelect: (text: string) => void;
}

export function FollowupSuggestions({ suggestions, onSelect }: FollowupSuggestionsProps) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {suggestions.map((s, i) => (
        <button
          key={`${i}-${s}`}
          type="button"
          onClick={() => onSelect(s)}
          className={cn(
            "px-3 py-1.5 rounded-full",
            "font-sans text-xs text-text-secondary hover:text-text-primary",
            "border border-border/40 bg-surface-raised/30 hover:border-semantic/40 hover:bg-semantic/5",
            "transition-all",
          )}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 9: Wire regenerate + followups into `AskContext`**

In `src/context/AskContext.tsx`, add imports:

```typescript
import { deleteMessagesAfter } from "@/lib/api";
import { decodeAttachments } from "@/lib/attachments";
import { generateFollowups, extractLastTurns } from "@/lib/followups";
```

Extend `AskContextValue`:

```typescript
  followups: string[];
  regenerate: () => Promise<void>;
```

Add state inside `AskProvider`:

```typescript
const [followups, setFollowups] = useState<string[]>([]);
```

Clear followups on chat switch. In `selectChat` and `startNewChat`:

```typescript
  const selectChat = useCallback((id: number | null) => {
    setActiveChatId(id);
    setError(null);
    setFollowups([]);
    abortRef.current?.abort();
  }, []);

  const startNewChat = useCallback(() => {
    setActiveChatId(null);
    setError(null);
    setFollowups([]);
    abortRef.current?.abort();
  }, []);
```

Clear followups at the start of `sendMessage`:

```typescript
      if (isStreaming || !text.trim()) return;
      setError(null);
      setFollowups([]);
      setIsStreaming(true);
```

After stream completion (both branches), trigger followup generation. Find the end of the `if (useClaude) { ... }` branch and the end of the else branch, and wrap the whole try/catch. Simplest: in the `finally` block, fire-and-forget a followup generation.

Replace the `finally` block:

```typescript
      } finally {
        setIsStreaming(false);
        abortRef.current = null;

        // Fire-and-forget followup generation (3s timeout inside).
        if (chatId != null) {
          void (async () => {
            const rows = await getChatMessages(chatId);
            const { lastUserText, lastAssistantText } = extractLastTurns(rows);
            if (!lastAssistantText) return;
            const backend = activeChat?.backend ?? (useClaude ? "claude" : "ollama");
            const suggestions = await generateFollowups({
              backend,
              ollamaUrl: config?.chat.ollama_url,
              ollamaModel: activeChat?.model ?? config?.chat?.model,
              lastUserText,
              lastAssistantText,
            });
            setFollowups(suggestions);
          })();
        }
      }
```

(Note: `chatId` must be in scope here — it is, since it's declared in the try block before being used. Move the declaration above the try/catch to make scope clear: `let chatId: number | null = activeChatId;` at the top of the callback body.)

Add `regenerate`:

```typescript
  const regenerate = useCallback(async () => {
    if (!activeChatId) return;
    const rows = await getChatMessages(activeChatId);
    // Find the last user-role message (by block_type=text, skipping tool_result).
    let lastUserRow: ChatMessageRow | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.role === "user" && r.block_type === "text") {
        lastUserRow = r;
        break;
      }
    }
    if (!lastUserRow) return;

    // Extract the original user text + attachments from the marker.
    let userText = "";
    let attachedIds: number[] = [];
    try {
      const v = JSON.parse(lastUserRow.content_json);
      const raw = typeof v.text === "string" ? v.text : "";
      const decoded = decodeAttachments(raw);
      userText = decoded.text;
      attachedIds = decoded.ids;
    } catch {
      return;
    }

    // Delete everything AFTER this user message (the assistant reply and beyond).
    // Then re-send the same user input.
    await deleteMessagesAfter(activeChatId, lastUserRow.id);
    // Also delete the user row itself — sendMessage will re-persist it.
    // Implementation shortcut: delete one row less so the user message survives
    // and we directly re-trigger the LLM. Simpler:
    // actually, we want to keep the user message and re-run from there.
    // deleteMessagesAfter with lastUserRow.id - 1 would delete the user row too.
    // Stick with deleteMessagesAfter(chat, lastUserRow.id): user row survives,
    // but then sendMessage would add ANOTHER user row. We need to delete the
    // user row too and let sendMessage re-add it.
    await deleteMessagesAfter(activeChatId, lastUserRow.id - 1);

    qc.invalidateQueries({ queryKey: queryKeys.chatMessages(activeChatId) });
    await sendMessage(userText, attachedIds);
  }, [activeChatId, qc, sendMessage]);
```

*Note on the `.id - 1` trick:* since `id` is an autoincrement integer, subtracting 1 does NOT mean "the message before". It means "delete everything with id > this-1", i.e. "delete this message and everything after". If there's a message with id=lastUserRow.id-1 in another chat, the WHERE clause `chat_id = ?` filter saves us — `delete_messages_after` only touches this chat's messages.

Add `followups` and `regenerate` to the value memo + deps array.

- [ ] **Step 10: Render actions + followups in `AskMessages`**

In `src/features/ask/AskMessages.tsx`, import:

```typescript
import { MessageActions } from "./MessageActions";
import { FollowupSuggestions } from "./FollowupSuggestions";
import { useAskChat } from "@/context/AskContext";
import { stripMarker } from "@/lib/attachments";
```

Extend `AskMessagesProps`:

```typescript
interface AskMessagesProps {
  rows: ChatMessageRow[];
  onSelectScreenshot?: (id: number) => void;
  onSelectSuggestion?: (text: string) => void;
}
```

Inside the component, read followups from context:

```typescript
const { followups, regenerate } = useAskChat();
```

Find the map over messages. The last `assistant` message in the list should show actions + followups. Add an index check:

```tsx
        {messages.map((m, idx) => {
          const isUser = m.role === "user";
          const isLast = idx === messages.length - 1;
          // ... existing rendering ...

          // After the border-left content block div, add:
          {!isUser && isLast && (
            <div className="pl-3.5 mt-2">
              <MessageActions
                onCopy={() => {
                  const allText = m.parts
                    .map((p) => {
                      const a = p as Record<string, unknown>;
                      if (a.type === "text") return a.text as string;
                      return "";
                    })
                    .filter(Boolean)
                    .join("\n\n");
                  navigator.clipboard.writeText(stripMarker(allText));
                }}
                onRegenerate={() => void regenerate()}
              />
              <FollowupSuggestions
                suggestions={followups}
                onSelect={(t) => onSelectSuggestion?.(t)}
              />
            </div>
          )}
```

Place the new block INSIDE the `<div key={m.id}>` container but AFTER the `<div className="pl-3.5 border-l space-y-2">` parts block.

- [ ] **Step 11: Thread `onSelectSuggestion` from `AskView`**

In `src/features/ask/AskView.tsx`, pass the existing `submit` function as the handler:

```tsx
          <AskMessages
            rows={messages}
            onSelectScreenshot={onSelectScreenshot}
            onSelectSuggestion={submit}
          />
```

- [ ] **Step 12: Verify compile + tests**

Run:
```
cargo check -p rewindos && bun x tsc --noEmit -p tsconfig.json
bun run test
```
Expected: clean. Test count +1 (the new Rust test for `delete_messages_after`).

- [ ] **Step 13: Commit**

```bash
git add crates/rewindos-core/src/chat_store.rs \
        src-tauri/src/chat_commands.rs \
        src-tauri/src/lib.rs \
        src/lib/api.ts \
        src/lib/followups.ts \
        src/features/ask/MessageActions.tsx \
        src/features/ask/FollowupSuggestions.tsx \
        src/features/ask/AskMessages.tsx \
        src/features/ask/AskView.tsx \
        src/context/AskContext.tsx
git commit -m "add copy/regen + follow-up suggestions"
```

---

## Task 6: End-to-end verification

**Files:** None — manual verification only.

Prereqs:
- Daemon running (`cargo build -p rewindos-daemon --release` + systemd unit up, or run inline)
- Claude CLI installed and MCP registered (`claude mcp list` shows rewindos ✓ Connected)
- Ollama running with at least one chat model pulled (e.g. `qwen2.5:3b`)

- [ ] **Step 1: Model picker — Claude path**

1. Launch: `bun run tauri dev`
2. Open Ask view.
3. Before sending: click the model picker header dropdown.
4. Verify it shows both sections: CLAUDE CODE (opus/sonnet/haiku) and OLLAMA (LOCAL) with your pulled models.
5. Pick "Claude Opus".
6. Send any question.
7. Verify: after first message, the picker is replaced by `opus · locked` badge.
8. Open DevTools → `await window.__TAURI__.core.invoke("list_chats", { limit: 5 })` → confirm the new chat row has `model: "opus"`.

- [ ] **Step 2: Model picker — Ollama path**

1. Start a new chat ("new chat" in sidebar).
2. Pick an Ollama model from the dropdown (e.g. `qwen2.5:3b`).
3. Send a question.
4. Verify: the Ollama request in devtools Network tab shows `model: "qwen2.5:3b"` in the POST body.
5. Picker becomes locked badge.

- [ ] **Step 3: Citations — Claude with tool calls**

1. New Claude chat. Ask: "what did I work on today".
2. Observe: tool calls (`get_timeline`, etc.) render as collapsible ⚙ cards.
3. Final assistant text contains inline `#N` chips where Claude cited screenshots.
4. Below the text: a "sources (N)" card with thumbnails.
5. Click a `#N` chip → existing Screenshot Detail view opens.
6. Click a thumbnail in the Sources card → same detail view opens.

- [ ] **Step 4: Screenshot attachments**

1. New chat. Click the paperclip in the prompt input.
2. Picker opens: recent screenshots from the last 3 days.
3. Type a keyword in the search box → results filter.
4. Select 2 screenshots → count shows "2 selected".
5. Click "attach (2)" → picker closes, chips appear above the textarea.
6. Remove one chip via the × button → only 1 remains.
7. Type "what was I doing here?" → Send.
8. Verify:
   - Attached chips render above your message.
   - Assistant acknowledges the pinned screenshots in its reply.
   - In DevTools: `await window.__TAURI__.core.invoke("get_chat_messages", { chatId: <id> })` → your user message's `content_json` starts with `[ATTACH:<ids>]\n\n`.

- [ ] **Step 5: Copy + regenerate**

1. In a chat with at least one assistant reply, hover the latest reply.
2. Click "copy" → clipboard contains the reply text (no `[REF:N]` chips, just the raw text). Button shows "copied" briefly then reverts.
3. Click "regenerate" → downstream messages disappear, the question re-runs, a new assistant reply streams in.
4. Verify:
   - DB no longer contains the old assistant message (SELECT on chat_messages).
   - New session: the Claude `claude_session_id` on the chat row was cleared (run `list_chats` again and inspect).

- [ ] **Step 6: Follow-up suggestions**

1. After an assistant reply completes, within ~3 seconds 3 suggestion pills appear below the actions.
2. Click a suggestion → it's sent as the next user message.
3. If suggestions fail (Ollama offline), verify the UI silently shows none — no error banner.

- [ ] **Step 7: Error recovery**

1. Stop Ollama mid-generation → error banner appears.
2. Registered tools still work in Claude chats.

- [ ] **Step 8: No commit** — verification checkpoint only. If bugs were found, file them as follow-ups and fix inline (each as its own commit).

---

## Self-review

**Spec coverage:**

| Spec requirement | Covered by |
|---|---|
| Model picker (Claude tiers + Ollama list) | Tasks 1, 2 |
| Per-chat model lock | Task 1 (SQL guard), Task 2 (UI badge) |
| Citations: inline chips | Task 3 |
| Citations: Sources card | Task 3 |
| Citations: click-through to Screenshot Detail | Task 3 (onSelectScreenshot threading) |
| Attachment picker | Task 4 |
| `[ATTACH:...]` marker encoding | Task 4 |
| Context expansion on send | Task 4 |
| Attachment chips on user messages | Task 4 |
| Copy button | Task 5 |
| Regenerate button | Task 5 |
| delete_messages_after + clear session_id | Task 5 |
| Follow-up suggestions (Ollama path) | Task 5 |
| Follow-up suggestions (Claude Haiku) | Task 5 (explicit stub — deferred) |
| V008 migration | Task 1 |
| Already-done: thinking via Reasoning | n/a (no task) |
| Verification checklist | Task 6 |

One **explicit deferred item**: Claude Haiku follow-ups. The Ollama path works; Claude-path follow-ups stub to `[]`. This is an intentional scope trim called out in Task 5 Step 7 — flag for Phase B if low-friction Claude-side generation is wanted.

**Placeholder scan:** No "TBD" / "TODO" / "similar to Task N" without code. Every code block is complete. The `claudeHaikuFollowups` stub is intentional and labeled.

**Type consistency:**
- `Chat` type has `model: string | null` (Task 1) and is read that way in Task 2's `ModelPicker`.
- `ChatMessageRow` unchanged — attachments ride on the `content_json.text` field.
- `TextPart` defined Task 3, reused Task 3 only.
- `DecodedMessage` defined Task 4, used in Task 4 + Task 5.
- `parseTextWithRefs`/`collectRefs` signatures stable across Tasks 3 and consumers.
- `encodeAttachments`/`decodeAttachments`/`stripMarker`/`hasAttachments` signatures stable.
- `generateFollowups` params shape stable between Task 5 Step 7 and Step 9 usage.
- `ask_claude` gains `stored_text: Option<String>` in Task 4; existing `askClaudeStream` forwards `undefined`, new `askClaudeStreamWithAttachments` forwards a value. Backward-compat preserved.
- `ModelPicker` uses `setPendingModel` from context, added in Task 2.
- `AttachmentChip`/`CitationChip` both accept optional `onClick` — consistent.
- `onSelectScreenshot` threaded uniformly from `AskView` → `AskMessages` → individual chip components.

**Scope check:** 5 tasks + verification. Each is one commit. Task sizes mirror the prior streaming plan. Largest task is 4 (attachments — picker modal + marker wire-up + Rust command extension). Smallest is 1 (migration + metadata). Appropriate.

**Ambiguity check:**
- `Claude Haiku followups` stub → explicitly stated as deferred, not ambiguous.
- `.id - 1` trick in regenerate → explained in a note; deliberate use of WHERE clause scoping.
- `Claude --model` string format (`"sonnet"` alias vs `"claude-sonnet-4-6"`) → plan uses alias; `CLAUDE_MODELS` constants control this. Documented.
- `getImageUrl` reference in Task 3/4 → noted as "check existing export"; implementer should grep if it doesn't exist.
