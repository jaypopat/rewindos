# Amazing Chat Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Ask view with model picker, inline citations + sources card, screenshot attachments, copy/regenerate, follow-up suggestions, and voice input — the "Claude.ai-grade polish" layer on top of the streaming foundation we already shipped.

**Architecture:** Additive only — no rewriting of streaming, persistence, or MCP paths. One schema addition (`chats.model`). Heavy reuse of the **ai-elements** component registry: `ModelSelector` (Command-palette picker), `Attachments`/`Attachment*` (chip rendering), `SpeechInput` (Web Speech API wrapper), and the existing `Sources`/`Reasoning`/`Tool`. Custom components only where ai-elements doesn't fit our app-specific UX (history picker modal, citation chip, message actions).

**Tech Stack:** Rust (rusqlite, refinery, tauri), TypeScript (React 19, TanStack Query), ai-elements components (conversation, message, sources, reasoning, tool, prompt-input, suggestion already installed in prior work; model-selector, attachments, speech-input installed in this plan).

---

## Context for the implementer

**Before starting**, read:
- `docs/superpowers/specs/2026-04-24-amazing-chat-phase-a-design.md` — design decisions
- `docs/superpowers/plans/2026-04-24-streaming-chat-and-sessions.md` — prior plan (foundation)

**Key invariants established by prior work:**
- `AppState.db` is `std::sync::Mutex<Database>` (not `Arc<Mutex<Database>>`) — inline the lock, pass `&state` into helpers.
- `Database::conn()` is `pub(crate)` — all SQL from `src-tauri` must go through `chat_store` helpers.
- `ChatBackend::parse_sql` / `ChatRole::parse_sql` / `BlockKind::parse_sql` (NOT `from_str`).
- `append_message` INSERTs + UPDATEs `last_activity_at`. Triggers populate `chat_messages_fts`.
- Tauri command names in `invoke_handler` use snake_case; TS passes camelCase which Tauri converts.
- Verification before commit: `cargo check -p rewindos && bun x tsc --noEmit -p tsconfig.json`.
- Pre-existing tsc warnings in `src/components/ui/badge.tsx` and `src/components/ui/button.tsx` are baseline (already fixed with ElementType annotation). Any NEW tsc errors block the task.
- Registry components live at `src/components/ai-elements/<name>.tsx`. Install via the manual registry-download approach documented in the prior plan (the `npx ai-elements@latest add` CLI is TTY-interactive and unreliable for automation; download JSON from `https://elements.ai-sdk.dev/api/registry/<name>.json` and extract `files[0].content`).

**Don't deviate silently.** If plan text contradicts reality (e.g. a function doesn't exist, a prop name changed), STOP and surface it before writing code.

---

## Task 1: V008 migration + `chats.model` + `set_model` command + Claude model constants

**Files:**
- Create: `crates/rewindos-core/migrations/V008__chat_model.sql`
- Modify: `crates/rewindos-core/src/schema.rs`
- Modify: `crates/rewindos-core/src/chat_store.rs`
- Modify: `src-tauri/src/chat_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/query-keys.ts`
- Create: `src/lib/claude-models.ts`

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

- [ ] **Step 4: Add `set_chat_model` helper**

Add to `chat_store.rs` near `set_claude_session_id`:

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

- [ ] **Step 5: Add unit test**

Add to the existing `#[cfg(test)] mod tests` block in `chat_store.rs`:

```rust
#[test]
fn set_chat_model_only_sets_when_null() {
    let db = Database::open_in_memory().unwrap();
    let id = create_chat(&db, "t", ChatBackend::Claude, None).unwrap();
    assert_eq!(get_chat(&db, id).unwrap().unwrap().model, None);

    set_chat_model(&db, id, "sonnet").unwrap();
    assert_eq!(get_chat(&db, id).unwrap().unwrap().model.as_deref(), Some("sonnet"));

    set_chat_model(&db, id, "opus").unwrap();
    assert_eq!(
        get_chat(&db, id).unwrap().unwrap().model.as_deref(),
        Some("sonnet"),
        "second call must not overwrite",
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

In `src-tauri/src/lib.rs`, add to the `chat_commands::` block in `invoke_handler!`:

```rust
            chat_commands::set_model,
```

- [ ] **Step 9: Extend TS `Chat` type + add `setModel` + `ollamaListModels`**

In `src/lib/api.ts`, update the `Chat` interface:

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

Append near the existing chat exports:

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
 * Lists locally-pulled Ollama models suitable for chat (excludes embedding-only
 * models like nomic-bert). Direct browser → Ollama HTTP call, no Tauri roundtrip.
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

In `src/lib/query-keys.ts`, add inside `queryKeys`:

```typescript
  ollamaModels: (baseUrl: string) => ["ollama-models", baseUrl] as const,
```

- [ ] **Step 11: Add Claude model constants**

Create `src/lib/claude-models.ts`:

```typescript
export interface ClaudeModel {
  id: string; // alias passed to claude CLI --model
  label: string;
  description: string;
}

export const CLAUDE_MODELS: ClaudeModel[] = [
  { id: "opus",   label: "Claude Opus",   description: "most capable · slowest"  },
  { id: "sonnet", label: "Claude Sonnet", description: "balanced · default"      },
  { id: "haiku",  label: "Claude Haiku",  description: "fastest · cheapest"      },
];

export const DEFAULT_CLAUDE_MODEL = "sonnet";
```

- [ ] **Step 12: Verify compile**

Run: `cargo check -p rewindos && bun x tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 13: Commit**

```bash
git add crates/rewindos-core/migrations/V008__chat_model.sql \
        crates/rewindos-core/src/schema.rs \
        crates/rewindos-core/src/chat_store.rs \
        src-tauri/src/chat_commands.rs \
        src-tauri/src/lib.rs \
        src/lib/api.ts src/lib/query-keys.ts src/lib/claude-models.ts
git commit -m "add chats.model column + set_model command"
```

---

## Task 2: Install ai-elements registry components + `ModelSelector` integration + Claude `--model` flag + Ollama `body.model`

**Files:**
- Create (via registry): `src/components/ai-elements/model-selector.tsx`
- Create (via registry): `src/components/ai-elements/attachments.tsx`
- Create (via registry): `src/components/ai-elements/speech-input.tsx`
- Modify: `src-tauri/src/claude_code.rs` (`ask_claude_stream_spawn` accepts model)
- Modify: `src-tauri/src/lib.rs` (pass `chat.model` through)
- Modify: `src/context/AskContext.tsx` (expose `activeChat`, `pendingModel`, `setPendingModel`, thread model into sendMessage)
- Create: `src/features/ask/AskModelPicker.tsx` (thin composition of `ModelSelector`)
- Modify: `src/features/ask/AskView.tsx` (replace inline model label with the picker)

- [ ] **Step 1: Install the three registry components**

Run this Python script to download `model-selector.tsx`, `attachments.tsx`, and `speech-input.tsx`:

```bash
python3 <<'PY'
import json, urllib.request, pathlib
for name in ["model-selector", "attachments", "speech-input"]:
    url = f"https://elements.ai-sdk.dev/api/registry/{name}.json"
    d = json.loads(urllib.request.urlopen(url).read())
    for f in d.get("files", []):
        p = pathlib.Path(f["path"])
        target = pathlib.Path("src/components/ai-elements") / p.name
        target.write_text(f["content"])
        print(f"wrote {target}")
    print(f"  deps: {d.get('dependencies')}")
    print(f"  registry-deps: {d.get('registryDependencies')}")
PY
```

- [ ] **Step 2: Rewrite `@/registry/default/ui/` imports**

The registry files use `@/registry/default/ui/` paths; our project maps `@/components/ui/`. Rewrite:

```bash
find src/components/ai-elements -name '*.tsx' -exec \
  sed -i 's|@/registry/default/ui/|@/components/ui/|g' {} +
find src/components/ai-elements -name '*.tsx' -exec \
  sed -i 's|@/registry/new-york/ui/|@/components/ui/|g' {} +
```

All registry deps (`command`, `dialog`, `button`, `hover-card`, `spinner`) are already installed from prior work. Npm deps (`ai`, `lucide-react`) are already in package.json.

- [ ] **Step 3: Confirm tsc**

Run: `bun x tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS" | grep -v "^src/components/ui/\(badge\|button\)\.tsx"`
Expected: no output (zero new errors).

If this fails with "Cannot find module" for any of the new files' imports, you may have missed a registry dep in the prior install. Grep the new files for their imports and install anything missing.

- [ ] **Step 4: Add `model` parameter to `ask_claude_stream_spawn`**

In `src-tauri/src/claude_code.rs`, update the signature and body:

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

- [ ] **Step 5: Pass `chat.model` through `ask_claude`**

In `src-tauri/src/lib.rs`, find `ask_claude`'s chat-lookup block:

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

Find the `ask_claude_stream_spawn` invocation:

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

- [ ] **Step 6: Verify Rust compiles**

Run: `cargo check -p rewindos`
Expected: clean.

- [ ] **Step 7: Extend `AskContext` with `activeChat`, `pendingModel`, `setPendingModel`**

In `src/context/AskContext.tsx`, add imports:

```typescript
import { listChats, setModel, type Chat } from "@/lib/api";
```

(Adjust the existing `@/lib/api` import to include these.)

Add `setModel` to imports. Add `Chat` type to imports.

Inside `AskProvider`, after the existing `useQuery` for messages, add:

```typescript
  const { data: activeChat = null } = useQuery<Chat | null>({
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

Add near the other state:

```typescript
  const [pendingModel, setPendingModelState] = useState<string | null>(null);
  const setPendingModel = useCallback((m: string | null) => {
    setPendingModelState(m);
  }, []);
```

Extend `AskContextValue`:

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
  pendingModel: string | null;
  setPendingModel: (model: string | null) => void;
}
```

Read config at the top of `AskProvider` (needed for default Ollama model). Find the existing `const config` inside the Ollama branch of `sendMessage` and verify there's also a top-level `getConfig` query; if not, add:

```typescript
  const { data: config } = useQuery({
    queryKey: queryKeys.config(),
    queryFn: getConfig,
  });
```

(Add `getConfig` and `queryKeys.config` to imports if not present.)

In `sendMessage`, right after `chatId = await createChat(...)`, add the model lock:

```typescript
        let chatId = activeChatId;
        if (chatId == null) {
          const title = text.slice(0, 60).trim() || "New chat";
          chatId = await createChat(title, useClaude ? "claude" : "ollama", null);
          setActiveChatId(chatId);
          const chosenModel =
            pendingModel ??
            (useClaude ? "sonnet" : (config as ChatConfigShape | undefined)?.chat.model ?? "");
          if (chosenModel) {
            await setModel(chatId, chosenModel);
          }
          setPendingModelState(null);
          qc.invalidateQueries({ queryKey: queryKeys.chats() });
          qc.invalidateQueries({ queryKey: ["chat", chatId] as const });
        }
```

(The `ChatConfigShape` type already exists in AskContext — reuse it.)

In the Ollama branch of `sendMessage`, change:

```typescript
          await ollamaChat({
            baseUrl: config.chat.ollama_url,
            model: config.chat.model,
```

to:

```typescript
          await ollamaChat({
            baseUrl: cfg.chat.ollama_url,
            model: activeChat?.model ?? cfg.chat.model,
```

(Where `cfg` is the locally-named config shim inside the branch — rename the inner `config` variable to `cfg` or access via the outer one; whichever avoids shadowing confusion. Simplest: rename the outer top-level one to `appConfig` to avoid any shadow.)

Add `pendingModel`, `setPendingModel`, `activeChat` to the `value` memo and its deps array.

- [ ] **Step 8: Create `AskModelPicker` composition**

Create `src/features/ask/AskModelPicker.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Lock, Zap } from "lucide-react";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorSeparator,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { getConfig, ollamaListModels } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from "@/lib/claude-models";
import { useAskChat } from "@/context/AskContext";
import { cn } from "@/lib/utils";

interface ChatUrlConfig {
  chat: { ollama_url: string; model: string };
}

export function AskModelPicker() {
  const { activeChat, pendingModel, setPendingModel } = useAskChat();
  const [open, setOpen] = useState(false);

  const { data: config } = useQuery({
    queryKey: queryKeys.config(),
    queryFn: getConfig,
  });
  const ollamaUrl = (config as unknown as ChatUrlConfig | undefined)?.chat.ollama_url ?? "";
  const defaultOllama = (config as unknown as ChatUrlConfig | undefined)?.chat.model;

  const { data: ollamaModels = [] } = useQuery({
    queryKey: queryKeys.ollamaModels(ollamaUrl),
    queryFn: () => ollamaListModels(ollamaUrl),
    enabled: !!ollamaUrl,
    staleTime: 60_000,
  });

  // Locked state: chat is active and has a model set
  if (activeChat?.model) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-0.5 border border-border/40 bg-surface-raised/30">
        <Zap className="size-3 text-semantic" />
        <span className="font-mono text-[10px] text-text-primary uppercase tracking-wider">
          {activeChat.model}
        </span>
        <Lock className="size-2.5 text-text-muted" />
      </div>
    );
  }

  // Editable state: no active chat yet (or chat not yet sent)
  const currentDisplay = pendingModel ?? defaultOllama ?? DEFAULT_CLAUDE_MODEL;

  const pick = (id: string) => {
    setPendingModel(id);
    setOpen(false);
  };

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 px-2 py-0.5 border border-border/40 bg-surface-raised/30 hover:border-border/60 focus:outline-none font-mono text-[10px] uppercase tracking-wider text-text-primary"
        >
          <Zap className="size-3 text-semantic" />
          {currentDisplay}
          <ChevronDown className="size-3 text-text-muted" />
        </button>
      </ModelSelectorTrigger>
      <ModelSelectorContent title="Choose a model">
        <ModelSelectorInput placeholder="search models..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>No matches.</ModelSelectorEmpty>
          <ModelSelectorGroup heading="Claude Code">
            {CLAUDE_MODELS.map((m) => (
              <ModelSelectorItem
                key={m.id}
                value={m.id}
                onSelect={() => pick(m.id)}
                className={cn(
                  "flex flex-col items-start gap-0.5",
                  currentDisplay === m.id && "bg-semantic/10",
                )}
              >
                <span className="text-sm text-text-primary">{m.label}</span>
                <span className="font-mono text-[10px] text-text-muted">
                  {m.description}
                </span>
              </ModelSelectorItem>
            ))}
          </ModelSelectorGroup>
          <ModelSelectorSeparator />
          <ModelSelectorGroup heading="Ollama (local)">
            {ollamaModels.length === 0 ? (
              <div className="px-2 py-1.5 font-mono text-[10px] text-text-muted/60 italic">
                no models pulled — run `ollama pull &lt;name&gt;`
              </div>
            ) : (
              ollamaModels.map((m) => (
                <ModelSelectorItem
                  key={m.name}
                  value={m.name}
                  onSelect={() => pick(m.name)}
                  className={cn(
                    "flex flex-col items-start gap-0.5",
                    currentDisplay === m.name && "bg-semantic/10",
                  )}
                >
                  <span className="text-sm text-text-primary">{m.name}</span>
                  {m.parameter_size && (
                    <span className="font-mono text-[10px] text-text-muted">
                      {m.parameter_size}
                    </span>
                  )}
                </ModelSelectorItem>
              ))
            )}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
```

- [ ] **Step 9: Wire into `AskView` header**

In `src/features/ask/AskView.tsx`, import:

```typescript
import { AskModelPicker } from "./AskModelPicker";
```

Find the header block and replace the backend-label span with the picker. The header becomes:

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
            <AskModelPicker />
          </div>
        </div>
```

Remove the now-unused `backendLabel` and `backendTitle` constants.

- [ ] **Step 10: Verify compile**

Run: `cargo check -p rewindos && bun x tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/components/ai-elements/model-selector.tsx \
        src/components/ai-elements/attachments.tsx \
        src/components/ai-elements/speech-input.tsx \
        src-tauri/src/claude_code.rs src-tauri/src/lib.rs \
        src/context/AskContext.tsx \
        src/features/ask/AskModelPicker.tsx \
        src/features/ask/AskView.tsx
git commit -m "install model-selector/attachments/speech-input + add model picker"
```

---

## Task 3: Citations — parse `[REF:N]`, render custom chips + Sources card

**Files:**
- Create: `src/lib/citations.ts`
- Create: `src/lib/citations.test.ts`
- Create: `src/features/ask/CitationChip.tsx`
- Create: `src/features/ask/CitationSources.tsx`
- Modify: `src/features/ask/AskMessages.tsx`
- Modify: `src/features/ask/AskView.tsx`
- Modify: `src-tauri/src/lib.rs`
- Modify: `crates/rewindos-core/src/db.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/query-keys.ts`

- [ ] **Step 1: Write failing tests**

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

- [ ] **Step 2: Run failing tests**

Run: `bun run test src/lib/citations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `citations.ts`**

Create `src/lib/citations.ts`:

```typescript
export type TextPart =
  | { type: "text"; text: string }
  | { type: "ref"; id: number };

const REF_RE = /\[REF:(\d+)\]/g;

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

- [ ] **Step 4: Run tests**

Run: `bun run test src/lib/citations.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Add Rust `get_screenshots_by_ids` helper**

In `crates/rewindos-core/src/db.rs`, near `get_screenshot`, add:

```rust
/// Bulk fetch by ids. Returns screenshots in the order they appear in `ids`,
/// skipping any missing. Used by the citations renderer to populate the
/// Sources card efficiently (one roundtrip instead of N).
pub fn get_screenshots_by_ids(&self, ids: &[i64]) -> Result<Vec<Screenshot>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
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
    let mut by_id: std::collections::HashMap<i64, Screenshot> =
        found.into_iter().map(|s| (s.id, s)).collect();
    Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
}
```

*Note:* the SELECT column list must match the `Screenshot` struct shape in `schema.rs`. If `get_screenshot` uses a different column order (e.g. includes `ocr_status`), mirror it exactly. **Do not invent columns.** Read `get_screenshot`'s implementation first if unsure.

- [ ] **Step 6: Add Tauri command + register**

In `src-tauri/src/lib.rs`, near `get_screenshot`:

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

Register in `invoke_handler!` alongside `get_screenshot`:

```rust
            get_screenshots_by_ids,
```

- [ ] **Step 7: Add TS wrapper + query key**

In `src/lib/api.ts`, near `getScreenshot`:

```typescript
export async function getScreenshotsByIds(ids: number[]): Promise<Screenshot[]> {
  return invoke("get_screenshots_by_ids", { ids });
}
```

(Use whatever the existing `Screenshot` type name is — grep for what `getScreenshot` returns.)

In `src/lib/query-keys.ts`:

```typescript
  screenshotsByIds: (ids: number[]) => ["screenshots-by-ids", ...ids] as const,
```

- [ ] **Step 8: Create `CitationChip`**

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

- [ ] **Step 9: Create `CitationSources`**

Create `src/features/ask/CitationSources.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { getScreenshotsByIds } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { convertFileSrc } from "@tauri-apps/api/core";

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
                src={convertFileSrc(s.thumbnail_path ?? s.file_path)}
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

- [ ] **Step 10: Integrate into `AskMessages`**

In `src/features/ask/AskMessages.tsx`, add imports:

```typescript
import { parseTextWithRefs, collectRefs } from "@/lib/citations";
import { CitationChip } from "./CitationChip";
import { CitationSources } from "./CitationSources";
```

Extend `AskMessagesProps`:

```typescript
interface AskMessagesProps {
  rows: ChatMessageRow[];
  onSelectScreenshot?: (id: number) => void;
}
```

Destructure `onSelectScreenshot` from props.

Replace the assistant-text branch. Find:

```tsx
                    return (
                      <div key={key} className={ASSISTANT_PROSE}>
                        <Streamdown>{text}</Streamdown>
                      </div>
                    );
```

Replace with:

```tsx
                    return (
                      <AssistantTextWithCitations
                        key={key}
                        text={text}
                        onSelectScreenshot={onSelectScreenshot}
                      />
                    );
```

At the bottom of the file (outside the main component), add:

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
  return (
    <>
      <div className={ASSISTANT_PROSE}>
        {parts.map((p, i) =>
          p.type === "text" ? (
            <Streamdown key={i}>{p.text}</Streamdown>
          ) : (
            <CitationChip key={i} id={p.id} onClick={onSelectScreenshot} />
          ),
        )}
      </div>
      {refIds.length > 0 && (
        <CitationSources ids={refIds} onSelect={onSelectScreenshot} />
      )}
    </>
  );
}
```

- [ ] **Step 11: Thread `onSelectScreenshot` from `AskView`**

In `src/features/ask/AskView.tsx`, change:

```typescript
export function AskView({ onSelectScreenshot: _onSelectScreenshot }: AskViewProps) {
```

to:

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
Expected: clean, test count +8 (54 total).

- [ ] **Step 13: Commit**

```bash
git add src/lib/citations.ts src/lib/citations.test.ts \
        src/lib/api.ts src/lib/query-keys.ts \
        crates/rewindos-core/src/db.rs src-tauri/src/lib.rs \
        src/features/ask/CitationChip.tsx \
        src/features/ask/CitationSources.tsx \
        src/features/ask/AskMessages.tsx \
        src/features/ask/AskView.tsx
git commit -m "render [REF:N] as citation chips + sources card"
```

---

## Task 4: Screenshot attachments — custom picker modal + `Attachments` chip rendering

**Files:**
- Create: `src/lib/attachments.ts`
- Create: `src/lib/attachments.test.ts`
- Create: `src/features/ask/AttachmentPicker.tsx`
- Modify: `src/features/ask/AskView.tsx`
- Modify: `src/features/ask/AskMessages.tsx`
- Modify: `src/context/AskContext.tsx`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Write failing tests for the marker encode/decode**

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

  it("stripMarker + hasAttachments edge cases", () => {
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

- [ ] **Step 5: Create `AttachmentPicker` modal**

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
import { search, type SearchFilters } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { convertFileSrc } from "@tauri-apps/api/core";

interface AttachmentPickerProps {
  open: boolean;
  onClose: () => void;
  onAttach: (ids: number[]) => void;
}

const DAY = 86_400;

export function AttachmentPicker({ open, onClose, onAttach }: AttachmentPickerProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());

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
                      src={convertFileSrc(r.thumbnail_path ?? r.file_path)}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="p-1.5">
                    <div className="font-mono text-[10px] text-semantic/70">#{r.id}</div>
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

- [ ] **Step 6: Update `ask_claude` to accept split stored/sent prompts**

The Rust `ask_claude` currently takes one `prompt` and stores it + sends it. With attachments the stored and sent versions differ. Add `stored_text: Option<String>`:

In `src-tauri/src/lib.rs`, replace `ask_claude`'s signature:

```rust
#[tauri::command]
async fn ask_claude(
    state: State<'_, AppState>,
    chat_id: i64,
    prompt: String,
    stored_text: Option<String>,
    on_event: tauri::ipc::Channel<ask_stream::AskStreamEvent>,
) -> Result<(), String> {
```

Find the persist block:

```rust
    {
        let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
        let body = serde_json::json!({ "text": prompt }).to_string();
```

Replace with:

```rust
    {
        let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
        let to_store = stored_text.as_deref().unwrap_or(&prompt);
        let body = serde_json::json!({ "text": to_store }).to_string();
```

The rest uses `prompt` for the CLI call — correct.

- [ ] **Step 7: Update `askClaudeStream` + add attachments variant**

In `src/lib/api.ts`, keep the existing `askClaudeStream` unchanged (Tauri will pass the optional `storedText` as undefined, matching `Option<String>`). Add alongside it:

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

- [ ] **Step 8: Thread attachments through `AskContext.sendMessage`**

In `src/context/AskContext.tsx`, add imports:

```typescript
import {
  askClaudeStreamWithAttachments,
  getScreenshotsByIds,
} from "@/lib/api";
import { encodeAttachments } from "@/lib/attachments";
```

Update `AskContextValue`:

```typescript
  sendMessage: (text: string, attachedIds?: number[]) => Promise<void>;
```

Update `sendMessage`'s signature and internals. Find `const sendMessage = useCallback(\n    async (text: string) => {`. Replace with:

```typescript
  const sendMessage = useCallback(
    async (text: string, attachedIds: number[] = []) => {
```

After the `createChat`/model-lock block (where chatId is established), add:

```typescript
        const expandedText = await buildAttachedContext(attachedIds, text);
        const storedText = encodeAttachments(attachedIds, text);
```

Replace the Claude branch:

```typescript
        if (useClaude) {
          await askClaudeStream(chatId, text, (ev) => {
            handleEvent(ev, chatId!, qc, setError);
          });
        } else {
```

With:

```typescript
        if (useClaude) {
          if (attachedIds.length > 0) {
            await askClaudeStreamWithAttachments(
              chatId,
              storedText,
              expandedText,
              (ev) => handleEvent(ev, chatId!, qc, setError),
            );
          } else {
            await askClaudeStream(chatId, text, (ev) =>
              handleEvent(ev, chatId!, qc, setError),
            );
          }
        } else {
```

In the Ollama branch, find `await persistUserMessage(chatId, text);` and replace with:

```typescript
          await persistUserMessage(chatId, storedText);
```

Also change the Ollama message construction. Find:

```typescript
            { role: "user", content: text },
```

Replace with:

```typescript
            { role: "user", content: expandedText },
```

At the bottom of the file (outside the component), add:

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
    return `- #${s.id} (${ts}, ${app}${title})`;
  });
  return [
    "[Attached screenshots — the user pinned these as context]",
    ...lines,
    "[End attached screenshots]",
    "",
    userText,
  ].join("\n");
}
```

(We deliberately don't expand OCR text inline — that keeps send latency low. Claude can call `get_screenshot_detail` via MCP if it needs OCR content.)

- [ ] **Step 9: Wire picker + chip rendering into `AskView` using ai-elements `Attachments`**

In `src/features/ask/AskView.tsx`, add imports:

```typescript
import { Paperclip } from "lucide-react";
import { AttachmentPicker } from "./AttachmentPicker";
import {
  Attachments,
  Attachment,
  AttachmentPreview,
  AttachmentInfo,
  AttachmentRemove,
  type AttachmentData,
} from "@/components/ai-elements/attachments";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useQuery as useQuery2 } from "@tanstack/react-query";  // already imported; reuse
import { getScreenshotsByIds } from "@/lib/api";
```

(Don't double-import; merge with existing.)

Near the other state:

```typescript
const [attachedIds, setAttachedIds] = useState<number[]>([]);
const [pickerOpen, setPickerOpen] = useState(false);

// Fetch details for the currently-selected attachments so Attachments can
// render proper previews + metadata.
const { data: attachedShots = [] } = useQuery({
  queryKey: queryKeys.screenshotsByIds(attachedIds),
  queryFn: () => getScreenshotsByIds(attachedIds),
  enabled: attachedIds.length > 0,
  staleTime: 60_000,
});

// Map screenshot rows to ai-elements AttachmentData shape.
// We use the FileUIPart variant with a mediaType of "image/webp" since our
// screenshots are webp. The id is the string form of our screenshot id.
const attachmentData: AttachmentData[] = attachedShots.map((s) => ({
  type: "file",
  id: String(s.id),
  url: convertFileSrc(s.thumbnail_path ?? s.file_path),
  filename: `#${s.id} · ${s.app_name ?? "unknown"}`,
  mediaType: "image/webp",
})) as AttachmentData[];
```

Update `submit`:

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

Above `<PromptInput>` add the attachment row:

```tsx
            {attachedIds.length > 0 && (
              <div className="mb-2">
                <Attachments variant="inline">
                  {attachmentData.map((data) => (
                    <Attachment key={data.id} data={data}>
                      <AttachmentPreview />
                      <AttachmentInfo />
                      <AttachmentRemove
                        onClick={() =>
                          setAttachedIds((prev) =>
                            prev.filter((x) => String(x) !== data.id),
                          )
                        }
                      />
                    </Attachment>
                  ))}
                </Attachments>
              </div>
            )}
```

In `<PromptInputFooter>`, add the paperclip before the keyboard hint:

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

At the end of the component's return:

```tsx
      <AttachmentPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAttach={(ids) =>
          setAttachedIds((prev) => Array.from(new Set([...prev, ...ids])))
        }
      />
```

- [ ] **Step 10: Render attachment chips on persisted user messages**

In `src/features/ask/AskMessages.tsx`, add imports:

```typescript
import { decodeAttachments } from "@/lib/attachments";
import { useQuery } from "@tanstack/react-query";
import { getScreenshotsByIds } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import {
  Attachments,
  Attachment,
  AttachmentPreview,
  AttachmentInfo,
  type AttachmentData,
} from "@/components/ai-elements/attachments";
import { convertFileSrc } from "@tauri-apps/api/core";
```

Extend `AskMessagesProps` (if not already done in Task 3):

```typescript
interface AskMessagesProps {
  rows: ChatMessageRow[];
  onSelectScreenshot?: (id: number) => void;
}
```

Replace the user-text branch. Find:

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

Replace with:

```tsx
                    if (isUser) {
                      return (
                        <UserTextWithAttachments
                          key={key}
                          text={text}
                          onSelectScreenshot={onSelectScreenshot}
                        />
                      );
                    }
```

At the bottom of the file, add:

```tsx
function UserTextWithAttachments({
  text,
  onSelectScreenshot: _onSelectScreenshot,
}: {
  text: string;
  onSelectScreenshot?: (id: number) => void;
}) {
  const decoded = decodeAttachments(text);
  const { data: shots = [] } = useQuery({
    queryKey: queryKeys.screenshotsByIds(decoded.ids),
    queryFn: () => getScreenshotsByIds(decoded.ids),
    enabled: decoded.ids.length > 0,
    staleTime: 60_000,
  });

  const attachmentData: AttachmentData[] = shots.map((s) => ({
    type: "file",
    id: String(s.id),
    url: convertFileSrc(s.thumbnail_path ?? s.file_path),
    filename: `#${s.id} · ${s.app_name ?? "unknown"}`,
    mediaType: "image/webp",
  })) as AttachmentData[];

  return (
    <div className="space-y-2">
      {decoded.ids.length > 0 && (
        <Attachments variant="inline">
          {attachmentData.map((data) => (
            <Attachment key={data.id} data={data}>
              <AttachmentPreview />
              <AttachmentInfo />
            </Attachment>
          ))}
        </Attachments>
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

*Note:* `_onSelectScreenshot` is underscore-prefixed because ai-elements' `Attachment` doesn't expose an `onClick` on the preview. If clickthrough on user-side chips is desired, wrap `AttachmentPreview` in a button — deferred to a later polish pass.

- [ ] **Step 11: Verify compile + tests**

Run:
```
cargo check -p rewindos && bun x tsc --noEmit -p tsconfig.json
bun run test
```
Expected: clean, test count +5 (59 total).

- [ ] **Step 12: Commit**

```bash
git add src/lib/attachments.ts src/lib/attachments.test.ts \
        src/lib/api.ts src-tauri/src/lib.rs \
        src/features/ask/AttachmentPicker.tsx \
        src/features/ask/AskView.tsx \
        src/features/ask/AskMessages.tsx \
        src/context/AskContext.tsx
git commit -m "add screenshot attachment picker + Attachments chip rendering"
```

---

## Task 5: Copy/regenerate + follow-up suggestions

**Files:**
- Create: `src/features/ask/MessageActions.tsx`
- Create: `src/features/ask/FollowupSuggestions.tsx`
- Create: `src/lib/followups.ts`
- Modify: `crates/rewindos-core/src/chat_store.rs`
- Modify: `src-tauri/src/chat_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/context/AskContext.tsx`
- Modify: `src/features/ask/AskMessages.tsx`
- Modify: `src/features/ask/AskView.tsx`

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

In the tests module:

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
 * Generate 3 short follow-up questions from the last turn. Ollama-backed in
 * Phase A; Claude-backed (Haiku) is a stub that returns [] — can be filled
 * in later via a dedicated one-shot Tauri command. 3-second timeout.
 * Ephemeral (not persisted).
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
      return []; // Phase A: stubbed; Claude Haiku oneshot is a follow-up.
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

- [ ] **Step 8: Create `FollowupSuggestions`**

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

- [ ] **Step 9: Wire into `AskContext`**

In `src/context/AskContext.tsx`, add imports:

```typescript
import { deleteMessagesAfter, getChatMessages } from "@/lib/api";
import { decodeAttachments } from "@/lib/attachments";
import { generateFollowups, extractLastTurns } from "@/lib/followups";
```

Extend `AskContextValue`:

```typescript
  followups: string[];
  regenerate: () => Promise<void>;
```

Inside `AskProvider`, add state:

```typescript
const [followups, setFollowups] = useState<string[]>([]);
```

In `selectChat` and `startNewChat`, clear followups:

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

At the start of `sendMessage`, clear followups:

```typescript
      setError(null);
      setFollowups([]);
      setIsStreaming(true);
```

At the end (in the `finally` block), trigger followup generation. Replace the existing `finally`:

```typescript
      } finally {
        setIsStreaming(false);
        abortRef.current = null;

        if (chatId != null) {
          void (async () => {
            const rows = await getChatMessages(chatId!);
            const { lastUserText, lastAssistantText } = extractLastTurns(rows);
            if (!lastAssistantText) return;
            const backend = activeChat?.backend ?? (useClaude ? "claude" : "ollama");
            const suggestions = await generateFollowups({
              backend,
              ollamaUrl: (config as ChatConfigShape | undefined)?.chat.ollama_url,
              ollamaModel: activeChat?.model ?? (config as ChatConfigShape | undefined)?.chat.model,
              lastUserText,
              lastAssistantText,
            });
            setFollowups(suggestions);
          })();
        }
      }
```

(If `chatId` was declared inside the `try` block, hoist it to a `let chatId: number | null = activeChatId;` at the top of the callback body.)

Add `regenerate`:

```typescript
  const regenerate = useCallback(async () => {
    if (!activeChatId) return;
    const rows = await getChatMessages(activeChatId);
    let lastUserRow: ChatMessageRow | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.role === "user" && r.block_type === "text") {
        lastUserRow = r;
        break;
      }
    }
    if (!lastUserRow) return;

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

    // Delete the last user row AND everything after. sendMessage will
    // re-persist the user message as part of its normal flow.
    await deleteMessagesAfter(activeChatId, lastUserRow.id - 1);
    qc.invalidateQueries({ queryKey: queryKeys.chatMessages(activeChatId) });
    await sendMessage(userText, attachedIds);
  }, [activeChatId, qc, sendMessage]);
```

Add `followups`, `regenerate` to `value` memo + deps.

- [ ] **Step 10: Render actions + followups in `AskMessages`**

In `src/features/ask/AskMessages.tsx`, add imports:

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

Inside the component, read context state:

```typescript
const { followups, regenerate } = useAskChat();
```

In the map over messages, track the last-assistant index. Change the map signature to use the index:

```tsx
        {messages.map((m, idx) => {
          const isUser = m.role === "user";
          const isLast = idx === messages.length - 1;
```

Inside each message container, AFTER the `<div className="pl-3.5 border-l ...">` block, add:

```tsx
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

- [ ] **Step 11: Thread `onSelectSuggestion` from `AskView`**

In `src/features/ask/AskView.tsx`:

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
Expected: clean, Rust test count +1.

- [ ] **Step 13: Commit**

```bash
git add crates/rewindos-core/src/chat_store.rs \
        src-tauri/src/chat_commands.rs src-tauri/src/lib.rs \
        src/lib/api.ts src/lib/followups.ts \
        src/features/ask/MessageActions.tsx \
        src/features/ask/FollowupSuggestions.tsx \
        src/features/ask/AskMessages.tsx \
        src/features/ask/AskView.tsx \
        src/context/AskContext.tsx
git commit -m "add copy/regen + follow-up suggestions"
```

---

## Task 6: Voice input via `SpeechInput`

**Files:**
- Modify: `src/features/ask/AskView.tsx`
- Modify: `src-tauri/capabilities/default.json` (microphone permission if needed)

- [ ] **Step 1: Check Tauri capabilities for microphone access**

Read `src-tauri/capabilities/default.json`. Tauri v2's Chromium WebView allows `getUserMedia`/Web Speech API **without explicit Tauri permission** — they're controlled by the underlying Chromium stack. However, some Linux Wayland environments require the `mic` portal. Verify no additional Tauri permission is needed:

Run the app briefly later in Task 7 verification; if speech input fails with a permission error, we'll add `allow` entries here then.

For Phase A Step 1, **no change** to capabilities is expected. Skip this step unless a later verification run shows a permission error.

- [ ] **Step 2: Wire `SpeechInput` into `AskView`'s `PromptInputFooter`**

In `src/features/ask/AskView.tsx`, add import:

```typescript
import { SpeechInput } from "@/components/ai-elements/speech-input";
```

In the `<PromptInputFooter>`, add the `SpeechInput` next to the paperclip. The footer becomes:

```tsx
              <PromptInputFooter className="px-3 pb-2 pt-1 rounded-none">
                <div className="flex items-center gap-1.5 text-text-muted">
                  <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    disabled={isStreaming || !chatReady}
                    className="text-text-muted hover:text-semantic disabled:opacity-40 disabled:hover:text-text-muted transition-colors p-1"
                    title="attach screenshot"
                    aria-label="attach screenshot"
                  >
                    <Paperclip className="size-4" />
                  </button>
                  <SpeechInput
                    variant="ghost"
                    size="icon"
                    className="size-auto p-1 text-text-muted hover:text-semantic hover:bg-transparent"
                    onTranscriptionChange={(text) => setInput((prev) => (prev ? `${prev} ${text}` : text))}
                    disabled={isStreaming || !chatReady}
                  />
                  <span className="font-mono text-[10px] uppercase tracking-wider ml-2">
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

*Note on appending*: using `(prev) => prev ? `${prev} ${text}` : text` means partial transcriptions concatenate with a space rather than replacing. This feels right for the "keep talking, add a sentence" pattern. If you prefer "each speech session replaces the whole input," use `(_) => text` instead.

- [ ] **Step 3: Verify compile**

Run: `bun x tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/features/ask/AskView.tsx
git commit -m "add speech input to prompt (Web Speech API via ai-elements SpeechInput)"
```

---

## Task 7: End-to-end verification

**Files:** None — manual verification only.

Prereqs:
- Daemon running (`cargo build -p rewindos-daemon --release` + systemd unit up, or run inline)
- Claude CLI installed + MCP registered (`claude mcp list` shows rewindos ✓ Connected)
- Ollama running with a chat model pulled (e.g. `qwen2.5:3b`)
- Microphone connected + accessible (for Task 6 verification)

- [ ] **Step 1: Model picker — Claude path**

1. `bun run tauri dev`.
2. Open Ask view, open the model picker badge.
3. `ModelSelector` opens as a Command-palette modal with search + two groups (Claude Code + Ollama).
4. Pick "Claude Opus".
5. Send a question.
6. After first message, picker becomes `opus · locked` badge.
7. DevTools: `await window.__TAURI__.core.invoke("list_chats", { limit: 5 })` → confirm `model: "opus"`.

- [ ] **Step 2: Model picker — Ollama path**

1. New chat. Open picker. Pick an Ollama model (e.g. `qwen2.5:3b`).
2. Send a question.
3. DevTools Network tab: Ollama request body contains `"model":"qwen2.5:3b"`.
4. Picker becomes locked badge.

- [ ] **Step 3: Citations — Claude with tool calls**

1. New Claude chat. Ask "what did I work on today".
2. Tool calls render as collapsible ⚙ cards (prior work).
3. Final assistant text has inline `#N` chips where Claude cited screenshots.
4. Below the text: "sources (N)" card with thumbnails + app names + timestamps.
5. Click a `#N` chip → Screenshot Detail view opens.
6. Click a Sources thumbnail → same detail view opens.

- [ ] **Step 4: Screenshot attachments**

1. New chat. Click the paperclip.
2. Picker opens with recent screenshots + search.
3. Type a keyword, filter results.
4. Select 2 screenshots → click "attach (2)".
5. Picker closes; ai-elements `Attachments` chips appear above the textarea showing thumbnail + `#id · app`.
6. Click × on a chip to remove → one remains.
7. Type "what was I doing here?" → send.
8. Verify:
   - Attachment chips render above your user message.
   - Assistant acknowledges the pinned screenshots.
   - `get_chat_messages` shows user content_json prefixed with `[ATTACH:<ids>]\n\n`.

- [ ] **Step 5: Copy + regenerate**

1. Hover the latest assistant reply.
2. Click "copy" → clipboard has the text (no `[REF:N]` raw, no `[ATTACH:...]` marker). Button shows "copied" then reverts.
3. Click "regenerate" → downstream messages vanish, question re-runs, new reply streams in.
4. DevTools: confirm old assistant message is gone, `claude_session_id` is NULL on the chat row.

- [ ] **Step 6: Follow-up suggestions (Ollama path)**

1. In an Ollama chat, after a reply completes, wait up to 3 seconds.
2. 3 suggestion pills appear below actions.
3. Click one → it's sent as next user message.
4. If Ollama is stopped: no pills appear (silent-fail). No error banner.

*Note:* Claude chats show NO suggestions in Phase A — the Claude-Haiku path is a stub returning `[]`. This is expected.

- [ ] **Step 7: Speech input**

1. In a new or active chat, click the microphone icon in the prompt footer.
2. Browser prompts for mic permission (first time only) → allow.
3. Speak a sentence.
4. Transcribed text appears in the textarea.
5. Click the mic again to stop.
6. Send.

If the mic icon doesn't appear or shows a "not supported" state: you're probably running on a non-Chromium WebView. Web Speech API isn't universal — skip speech on that platform.

If permission fails: add to `src-tauri/capabilities/default.json` and investigate whether Wayland's pipewire portal is blocking. Tauri v2 inherits the OS's media permission model.

- [ ] **Step 8: Error recovery**

1. Stop Ollama mid-generation → error banner.
2. Claude MCP tools still work.
3. No app crash; sidebar state preserved; new chat works.

- [ ] **Step 9: No commit** — verification checkpoint only. Log bugs as fixes on their own commits.

---

## Self-review

**Spec coverage:**

| Spec requirement | Covered by |
|---|---|
| Model picker (Claude tiers + Ollama list) via ai-elements ModelSelector | Tasks 1, 2 |
| Per-chat model lock | Task 1 (SQL guard), Task 2 (UI badge) |
| Citations: inline chips | Task 3 (custom CitationChip) |
| Citations: Sources card | Task 3 |
| Citations: click-through to Screenshot Detail | Task 3 |
| Attachments: picker modal | Task 4 (custom Dialog) |
| Attachments: chip rendering via ai-elements Attachments | Task 4 |
| Attachments: `[ATTACH:...]` marker encoding | Task 4 |
| Attachments: context expansion on send | Task 4 |
| Copy button | Task 5 |
| Regenerate button | Task 5 |
| delete_messages_after + clear session_id | Task 5 |
| Follow-up suggestions (Ollama) | Task 5 |
| Follow-up suggestions (Claude Haiku) | Task 5 (explicit stub — deferred) |
| V008 migration | Task 1 |
| Speech input (Web Speech API via SpeechInput) | Task 6 |
| Verification checklist | Task 7 |

**Explicit deferral**: Claude Haiku follow-ups stubbed in Task 5. Ollama path works; Claude chats show no followups. Noted in the spec as acceptable Phase-A scope trim.

**Placeholder scan:** No "TBD" / "TODO". Every code block is complete. The `SpeechInput` fallback (non-Chromium) is labeled as a verification-time discovery — not silently assumed to work.

**Type consistency:**
- `Chat` type: `model: string | null` (Task 1), read same way in Task 2.
- `TextPart`: defined Task 3, consumed Task 3 only.
- `DecodedMessage`: defined Task 4, consumed Tasks 4 + 5.
- `AttachmentData`: imported from ai-elements, used consistently in Task 4 (AskView + AskMessages).
- `ask_claude` gains `stored_text: Option<String>` in Task 4; existing `askClaudeStream` forwards undefined (maps to None).
- `parseTextWithRefs`/`collectRefs`/`encodeAttachments`/`decodeAttachments`/`stripMarker` signatures stable across consumers.
- `generateFollowups` / `extractLastTurns` signatures stable between Task 5 Steps 7 and 9.
- `onSelectScreenshot` threaded uniformly AskView → AskMessages.

**Scope check:** 6 tasks + verification. Task 6 (speech input) is tiny — 1 import + 1 component integration + 1 commit. Largest is Task 4 (attachments). Appropriate.

**Ambiguity check:**
- Model string format (alias vs full name) → plan uses aliases; `CLAUDE_MODELS` constants control this, documented.
- `.id - 1` in regenerate → explained inline; `delete_messages_after` is chat-scoped via WHERE clause.
- `SpeechInput` on non-Chromium WebView → plan explicitly acknowledges possible skip; not silently assumed.
- ai-elements `Attachments` preview click-through → deferred (underscore-prefix marks intent) rather than silently hand-wired.
- Tauri capability for mic → plan says "skip unless verification shows a permission error" rather than pre-emptively patching.
