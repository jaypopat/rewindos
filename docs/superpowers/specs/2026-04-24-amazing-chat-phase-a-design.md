# Amazing Chat — Phase A (Claude.ai-grade Polish)

**Date**: 2026-04-24
**Status**: Design approved; ready for implementation plan
**Previous work**: [2026-04-24-streaming-chat-and-sessions.md](../plans/2026-04-24-streaming-chat-and-sessions.md) — streaming + MCP + sidebar shipped

## Purpose

Extend the Ask view so it feels on par with chat.claude.com while remaining local-first and tied to RewindOS's screen history. The streaming and MCP foundation already ships. Phase A adds the polish features users expect from modern AI chat: model selection, visible source citations, manual screenshot attachments, copy/regenerate, and follow-up suggestions.

Phase A is explicitly polish — no new backends, no multimodal, no voice. Those are Phase B/C.

## Scope

### In scope

| Feature | Summary |
|---|---|
| **Model picker** | Header dropdown listing Claude tiers (opus/sonnet/haiku) + locally-installed Ollama models from `/api/tags`. Per-chat lock: model set on first message, cannot change mid-chat. New chat inherits last-selected model. |
| **Citations** | Parse `[REF:N]` markers in assistant text, render inline as `#42` chips, collect unique refs as a `<Sources>` card below the assistant message with thumbnails. Click either → existing Screenshot Detail view. |
| **Screenshot attach** | Paperclip button in prompt input opens a picker modal (recent screenshots + search). Selected screenshots become attachment chips above the user message text. On send, expanded into text context for the LLM. Stored as `[ATTACH:42,43]` marker prefix in `content_json`. |
| **Copy** | Icon under each assistant message — `navigator.clipboard.writeText(text)`. |
| **Regenerate** | Icon under each assistant message — deletes downstream messages (all rows with `id > last_user_msg.id` in this chat), re-invokes `sendMessage` with the last user text. |
| **Follow-up suggestions** | After stream completion, fire a second small LLM call asking for 3 short follow-up questions. Render as pills under the assistant message. Ephemeral (not persisted). 3-second timeout; silent-fail. |

### Already shipped (no work)

- Thinking display — `ai-elements/<Reasoning>` already wired in `AskMessages.tsx`, collapsed by default, shows extended thinking blocks from Claude.

### Out of scope for Phase A (explicit)

- **True image/file attachments** — Anthropic image-block uploads via CLI. Deferred to Phase B (multimodal).
- **Voice input/output** — Whisper + Piper. Deferred to Phase B.
- **Tool-call approvals** — per-call consent UI. Deferred to Phase C (power-user).
- **Like/thumbs feedback** — no destination (no training loop, no server). Dropped entirely.
- **"Auto" model routing** — smart selection based on question type. Interesting but needs its own design.

## Architecture

Phase A is additive — no rewriting of streaming/persistence/MCP paths shipped in the prior plan. Changes concentrate in four layers:

| Layer | Changes |
|---|---|
| **DB schema** | One column: `chats.model TEXT` (nullable). One migration: V008. |
| **Rust (src-tauri, rewindos-core)** | `chat_store::set_claude_model` + `chat_store::delete_messages_after`. `ask_claude_stream_spawn` learns `--model` flag. New Tauri commands: `set_model`, `delete_messages_after`. |
| **Frontend (src/lib)** | `parseTextWithRefs` + `collectRefs` pure functions (with unit tests). Extended `toUIMessages` to include ref metadata. New `getScreenshotsByIds(ids[])` bulk lookup. |
| **Frontend (src/features/ask)** | New: `ModelPicker`, `CitationChip`, `AttachmentPicker`, `AttachmentChip`, `MessageActions`, `FollowupSuggestions`. `AskMessages` and `AskView` extended to compose these. |

### Data flow

**Model selection**

```
ModelPicker click → setModel(chatId, "claude-sonnet-4.6") → UPDATE chats SET model = ?
                                                              WHERE id = ? AND model IS NULL
    (only sets if null — enforces "locked after first send")

On send:
  model = chat.model ?? default_for(chat.backend)
  Claude:  cmd.arg("--model").arg(model)
  Ollama:  body.model = model  (already wired)
```

**Citations**

```
assistant content_json.text = "You were in VS Code [REF:42] then Chrome [REF:43]."
    │
    ├─ parseTextWithRefs(text)  →  [
    │                                { type: "text", text: "You were in VS Code " },
    │                                { type: "ref", id: 42 },
    │                                { type: "text", text: " then Chrome " },
    │                                { type: "ref", id: 43 },
    │                                { type: "text", text: "." },
    │                              ]
    │
    ├─ collectRefs(parts)  →  [42, 43]
    │
    ├─ fetch: getScreenshotsByIds([42, 43])  (TanStack Query, cached)
    │
    └─ render: inline CitationChip per ref, <Sources> card at bottom
```

**Attachments**

```
User selects screenshots #42, #43 in picker
    │
    ├─ Frontend state: attachedIds = [42, 43]
    │
    ├─ On submit:
    │     1. contentToStore = "[ATTACH:42,43]\n\n" + userText
    │     2. contentToSendToLLM =
    │          "[Attached context]\n" +
    │          "- #42 (2026-04-24 10:23, VS Code): <ocr truncated>\n" +
    │          "- #43 (2026-04-24 10:25, Chrome):  <ocr truncated>\n" +
    │          "[End attached context]\n\n" + userText
    │     3. Persist contentToStore via append_chat_message
    │     4. Send contentToSendToLLM via askClaudeStream / ollamaChat
    │
    └─ On render:
         parse [ATTACH:42,43] marker out of text,
         fetch those screenshots,
         render as chips above user message
```

**Regenerate**

```
User clicks regen on assistant msg id=N
    │
    ├─ Find last user msg with id < N → id=M
    ├─ userText = parse text from msg M's content_json (strip [ATTACH:...] if present)
    ├─ deleteMessagesAfter(chatId, msgId=M)   (removes M+1 through last)
    ├─ sendMessage(userText, attachedIds=... from msg M's marker)
```

**Follow-up suggestions**

```
Stream completes (Done event for Claude, stream end for Ollama)
    │
    ├─ async generateFollowups(chatId, backend, model):
    │     build a tiny prompt from the last assistant turn + user turn,
    │     ask for JSON array of 3 short follow-ups,
    │     parse & dedupe,
    │     3-second timeout; silent-fail if exceeded
    │
    └─ setFollowups([...]) → render as 3 pills
       (state is local to AskContext, wiped on chat switch)
```

## Data model details

### `chats.model` column

- **Type**: `TEXT NULL`
- **Default**: NULL
- **Lifecycle**: NULL until first `setModel` call; cannot be changed thereafter (UPDATE guards with `WHERE model IS NULL`)
- **Values**:
  - Claude: `"claude-opus-4-7"`, `"claude-sonnet-4-6"`, `"claude-haiku-4-5"` (exact CLI `--model` accepted names)
  - Ollama: bare tag strings like `"qwen2.5:3b"`, `"llama3.2:1b"` (what `/api/tags` returns)

### `[ATTACH:N,N]` marker

- **Location**: leading substring of user `content_json.text`
- **Regex**: `^\[ATTACH:(\d+(?:,\d+)*)\]\n\n`
- **After marker**: original user text, unmodified
- **Invariant**: if a user message has attachments, marker is present; absence of marker means no attachments

### `[REF:N]` marker

- **Location**: anywhere in assistant `content_json.text`
- **Regex**: `\[REF:(\d+)\]` (global)
- **Source**: emitted by Claude per system prompt instruction (already in place)
- **Does NOT need persistence changes** — the marker is the text.

## Feature UI (compact)

### Model picker
Header dropdown (shadcn `<DropdownMenu>`). Two sections: "CLAUDE CODE" (opus/sonnet/haiku), "OLLAMA (LOCAL)" (enumerated). Current model has `●` marker. After first send: replaced by read-only badge `sonnet-4.6 · locked`. New chat resets picker to last-selected.

### Assistant message
```
● REWINDOS
│ Your text with #42 citation chips inline.
│
│ ┌─ sources (3) ──────────────┐
│ │ [thumb] [thumb] [thumb]    │
│ └────────────────────────────┘
│
│ [copy] [regen]
│
│ ◦ suggestion 1  ◦ suggestion 2  ◦ suggestion 3
```

Chips: monospace `#N`, inline-flex, `text-semantic/70` idle, `text-semantic` hover.
Sources: styled `<Sources>` from ai-elements with sharp corners + semantic-green accents.
Copy/regen: ghost icon buttons, `opacity-60 hover:opacity-100`.
Suggestions: rounded pills matching `AskEmptyState`'s suggestion style.

### User message with attachments
```
● YOU
│ [#42 thumb]  [#43 thumb]
│ what was I debugging here?
```

Attachment chips render as compact pills with thumbnail + id + timestamp. `×` close button only while composing.

### Prompt input
Paperclip icon in `PromptInputFooter` alongside keyboard hint. Click → opens `AttachmentPicker` modal. Selected attachments render as chips above the textarea, removable until send.

### Attachment picker modal
`<Dialog>` with search bar (delegates to `search_screenshots` Tauri command) + grid of thumbnails grouped by day (today/yesterday/older). Multi-select with checkmark. Footer: "attach N selected" primary button.

## Build sequence

Five implementation tasks + one verification. Each task is one commit. Similar scope per task to the prior streaming plan.

| # | Task | Depends on | Commit message |
|---|---|---|---|
| 1 | V008 migration + `chats.model` + `set_model` + TS bindings + model picker list sources (Claude tier constants + Ollama `/api/tags` query) | — | `add chats.model column + set_model command` |
| 2 | `ModelPicker` component + `AskView` header wire-up + `ask_claude_stream_spawn` `--model` flag + Ollama body.model | 1 | `add model picker with claude tiers + live ollama list` |
| 3 | Citations: `parseTextWithRefs` + `collectRefs` + 6 unit tests + `<CitationChip>` + `<Sources>` styling + `get_screenshots_by_ids` Tauri command + bulk-lookup `useScreenshots(ids[])` hook + `AskMessages` integration | — | `render [REF:N] as citation chips + sources card` |
| 4 | `AttachmentPicker` modal + attach button in `PromptInputFooter` + `attachedIds` state in `AskView` + `[ATTACH:...]` marker encode/decode + context expansion for LLM send + chip rendering on user messages | — | `add screenshot attachment picker + context expansion` |
| 5 | Copy/regen buttons + `delete_messages_after` Tauri command (clears `claude_session_id` as part of the same SQL transaction) + `MessageActions` component + `generateFollowups` helper + `FollowupSuggestions` pills + AskContext state | 2 (for model-aware generation) | `add copy/regen + follow-up suggestions` |
| 6 | Manual end-to-end verification (model switch, citations click, attach flow, copy/regen, suggestions) | 1-5 | (no commit) |

Tasks 3 and 4 are independent of each other and of tasks 1/2 — could be parallelized if desired.

## Verification checkpoints

Each task includes:
- Unit tests for new pure functions (`parseTextWithRefs`, `collectRefs`, marker regex)
- `cargo check -p rewindos` + `bun x tsc --noEmit` clean
- Visual smoke test of the new component in the dev app
- Task 6 is manual: send a message → verify model is locked on the chat row → send a Claude message with tool calls → verify citations render → pin a screenshot → send → verify chip renders → click copy → regen → verify downstream messages deleted → verify suggestion pills appear.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Claude CLI `--model` accepts names that don't match what we display in the picker | Hardcode the exact CLI-accepted strings as constants (e.g. `CLAUDE_MODELS = ["claude-opus-4-7", ...]`); display-name mapping lives in one const file. |
| `claude -p` doesn't support follow-up generation in a second call fast enough | Generation reuses whichever backend the chat is already using: Claude chat → Haiku (fastest tier, bypass `chat.model`); Ollama chat → same local model the chat used. Never crosses backend boundaries. 3s timeout. Silent-fail is acceptable — suggestions are nice-to-have. |
| `[ATTACH:...]` marker accidentally typed by user collides with our parser | Unlikely in practice. If it matters, change marker to something unlikely like `⟨ATTACH:42,43⟩` (Unicode brackets). Defer to encountering a real collision. |
| Regenerate deletes messages but `claude_session_id` on the chat row still points to the old Claude session — Claude may reference deleted turns | Clear `claude_session_id` when `delete_messages_after` is called. Next turn starts a fresh Claude session with the reconstructed history. |
| `generateFollowups` adds cost/latency per turn | Acceptable for Phase A. Haiku call is cheap. Budget 3s with hard timeout. User can disable in settings later (Phase 2 config flag). |

## Open questions (resolved)

All resolved during design:
- Q: Model picker scope → **Claude tiers + Ollama models, per-chat lock**
- Q: Citations UX → **inline chip + Sources card, click opens existing detail view**
- Q: Screenshot attach scope → **pin from history, text-context expansion, no image API**
- Q: Drop the "like" button → **yes, no feedback destination**
- Q: Suggestions persisted? → **no, ephemeral**
- Q: Thinking display needs work? → **no, already wired via `<Reasoning>`**

## Followups (explicit non-goals for Phase A, planned for later phases)

- **Phase B — multimodal/voice**: true image attachments (Anthropic image blocks via Claude CLI), voice input (Whisper), voice output (Piper TTS), wake word.
- **Phase C — power-user**: per-tool-call approvals, parallel chats (side-by-side), pinned context, richer export formats, auto-routing between models based on intent.

## Links

- Prior plan (foundation): [2026-04-24-streaming-chat-and-sessions.md](../plans/2026-04-24-streaming-chat-and-sessions.md)
- Prior design: [2026-04-17-agentic-rewindos-design.md](./2026-04-17-agentic-rewindos-design.md)
- ai-elements components already installed (used by this spec): `conversation`, `message`, `tool`, `reasoning`, `sources`, `prompt-input`, `suggestion`
