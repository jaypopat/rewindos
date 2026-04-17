# Agentic RewindOS — Design Spec

## Overview

Make RewindOS intelligent by exposing its data to Claude Code via MCP, adding voice interaction, and improving the in-app chat. Local-first stays the default; Claude Code is opt-in for users who want agentic capabilities.

## Principles

- **Local by default, Claude opt-in.** No API keys to manage. Either Claude Code is installed or it isn't.
- **RewindOS is the eyes, Claude Code is the brain.** RewindOS captures, indexes, and exposes data. Claude Code reasons and acts.
- **No premature tiers.** One local model (qwen2.5:3b), one Claude path. Target modern Linux desktops.
- **Ship the foundation first.** MCP server and chat routing before voice. Proactive features come later.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Tauri App (UI)                  │
│  Ask View ──→ auto-detects Claude Code or local  │
│  Voice indicator (listening/processing state)    │
└──────────────────┬──────────────────────────────┘
                   │ IPC (invoke / events)
┌──────────────────▼──────────────────────────────┐
│              rewindos-daemon                      │
│                                                  │
│  ┌─────────────┐  ┌──────────────────────────┐  │
│  │ MCP Server  │  │ Voice Pipeline           │  │
│  │ (stdio)     │  │ PipeWire mic → whisper-rs│  │
│  │             │  │ → route → piper TTS      │  │
│  └──────┬──────┘  └──────────────────────────┘  │
│         │                                        │
│  ┌──────▼──────────────────────────────────────┐│
│  │ Existing: Database, Search, OCR, Pipeline   ││
│  └─────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
         ▲                          │
         │ MCP tool calls           │ claude CLI stdout
         │                          ▼
┌─────────────────────────────────────────────────┐
│              Claude Code (external)              │
│  Invoked via CLI: claude -p "..." (MCP in config)│
│  Multi-turn retrieval, reasoning, action         │
└─────────────────────────────────────────────────┘
```

## Component 1: MCP Server (P0)

### What

An MCP server running inside `rewindos-daemon` that exposes RewindOS data as tools Claude Code can call.

### Transport

Stdio (standard MCP transport for Claude Code). The daemon binary acts as the MCP server process — Claude Code spawns it with an `--mcp` flag that puts it into MCP server mode instead of normal daemon mode.

### Tools

| Tool | Input | Returns |
|---|---|---|
| `search_screenshots` | `query: string`, `time_range?: {start, end}`, `app_filter?: string`, `limit?: number` | Array of `{id, timestamp, app_name, window_title, ocr_text_snippet}` |
| `get_timeline` | `start_time: i64`, `end_time: i64`, `app_filter?: string` | Chronological activity grouped by app sessions |
| `get_app_usage` | `start_time: i64`, `end_time: i64` | Array of `{app_name, minutes, session_count}` |
| `get_screenshot_detail` | `screenshot_id: i64` | `{id, timestamp, app_name, window_title, full_ocr_text, file_path}` |
| `get_recent_activity` | `minutes?: number` (default 30) | Same as `get_timeline` but for the last N minutes |

### Implementation

- New module: `crates/rewindos-daemon/src/mcp.rs`
- Uses the `rmcp` crate (Rust MCP SDK) for protocol handling
- Each tool is a thin wrapper around existing `Database` methods in `db.rs`
- `search_screenshots` uses the existing `hybrid_search` (FTS5 + sqlite-vec RRF fusion) when Ollama is reachable (the MCP process connects to Ollama over HTTP to embed the query, same as the daemon does), falls back to FTS-only
- Daemon entry point gets a new flag: `rewindos-daemon --mcp` starts a **separate process** in MCP server mode (stdio transport, no PipeWire capture, no D-Bus server). This is spawned by Claude Code, not the running daemon. It opens its own read-only SQLite connection — WAL mode allows concurrent readers alongside the capture pipeline.

### Registration

Two paths:
1. **Manual:** User adds to `~/.claude/settings.json` under `mcpServers`
2. **One-click:** Settings > AI tab gets a "Connect to Claude Code" button that writes the config and verifies the connection

Config entry:
```json
{
  "mcpServers": {
    "rewindos": {
      "command": "rewindos-daemon",
      "args": ["--mcp"]
    }
  }
}
```

## Component 2: In-App Chat Upgrade (P0)

### What

Route Ask view queries through Claude Code when available, with cleaner streaming.

### Current problems

1. Local model (qwen2.5:3b) gives low-quality answers
2. Single-shot retrieval — one search, stuff context, hope for the best
3. Token streaming via manual Tauri events (`ask-token`, `ask-error`, `ask-done`) with mutex-locked session maps is clunky

### Claude Code chat path

When Claude Code is detected (and MCP server is registered via one-click setup or manual config):

1. User submits query in Ask view
2. Tauri command spawns `claude` CLI as a subprocess:
   ```
   claude -p "{user_query}" --output-format stream-json
   ```
   The MCP server is already registered in Claude Code's settings, so `claude` automatically has access to the `rewindos` tools — no inline config needed per invocation.
3. Stream stdout line-by-line back to the frontend via Tauri events
4. Claude Code uses MCP tools to search, iterate, refine — multi-turn retrieval happens automatically
5. Screenshot references in the response (`[REF:42]`) are parsed and made clickable in the UI (already supported)

### Local chat path

Unchanged. Ollama with qwen2.5:3b, existing intent classification and context assembly. Still works for users without Claude Code.

### Detection

On app startup and periodically:
- Check if `claude` binary exists on PATH (`which claude`)
- Store result in app state
- Ask view shows indicator: "claude" or "local"
- User can force local mode in settings if they prefer

### Streaming cleanup

The Claude Code path avoids the current `ask-token`/`ask-done` event pattern. Instead:
- Tauri command uses `Command::new("claude")` with piped stdout
- Reads `stream-json` output line by line
- Emits a single event type (`ask-stream`) with `{type: "text" | "done" | "error", content: string}`
- Frontend handles one event type instead of three

Local path keeps existing events for now — can be unified later.

## Component 3: Voice Pipeline (P1)

### What

Push-to-talk voice interaction. Hold hotkey, speak, release, get a spoken + visual response.

### Hotkey

Default: `Ctrl+Shift+V` (V for voice). Configurable in settings. 

**Note:** The existing `Ctrl+Shift+Space` hotkey is handled by the Tauri frontend (`useGlobalKeyboard.ts`), not the daemon. Wayland has no universal global hotkey mechanism for background processes. For v1, the voice hotkey follows the same pattern: Tauri app captures the keypress and signals the daemon to start/stop mic capture via D-Bus (`com.rewindos.Daemon.StartVoiceCapture` / `StopVoiceCapture`). This means voice requires the Tauri app to be running (can be minimized to tray).

### Speech-to-Text

- **Engine:** whisper.cpp via `whisper-rs` crate (Rust bindings)
- **Model:** `whisper-base.en` (~140MB, real-time on CPU). Bundled or downloaded on first use.
- **Runs in:** Daemon process, in-process (no subprocess)
- **Audio capture:** PipeWire (daemon already has PipeWire access for screen capture). Capture mic input while hotkey is held, feed PCM to whisper-rs on release.

### Text-to-Speech

- **Engine:** Piper TTS (neural, local, fast)
- **Model:** `en_US-lessac-medium` (~75MB, natural sounding)
- **Runs as:** Subprocess. Daemon pipes text to `piper` stdin, audio comes out stdout, played via PipeWire audio sink.
- **Fallback:** `espeak-ng` if Piper is not installed (lower quality but universally available)

### Flow

1. User holds `Ctrl+Shift+V`
2. Daemon starts capturing mic audio via PipeWire
3. Desktop notification or tray indicator shows "Listening..."
4. User releases hotkey
5. Audio buffer → whisper-rs → transcribed text
6. Route to Claude Code (if available) or Ollama
7. Response text → Piper TTS → audio playback
8. If Tauri app is open, response also appears in Ask view

### Daemon changes

- New module: `crates/rewindos-daemon/src/voice.rs`
- Voice pipeline runs as a tokio task, activated by hotkey
- Mic capture shares the PipeWire connection but uses a separate stream (audio, not video)
- Whisper model loaded once on daemon startup (if voice is enabled in config), kept in memory

### Config

```toml
[voice]
enabled = true
hotkey = "ctrl+shift+v"
whisper_model = "base.en"
tts_engine = "piper"     # or "espeak-ng"
```

## Component 4: Proactive Features (P2 — later)

Deferred to a future iteration. Noting the design here for reference.

### Daily Digest

- Scheduled job in daemon (configurable time, default 6pm, or on idle > 30min)
- Queries day's timeline + app usage
- Sends to local model (or Claude Code if available) for summarization
- Stored in `digests` table, shown in Dashboard view
- Desktop notification with summary

### Task Extraction

- Piggybacks on daily digest context
- Local model extracts 3-5 actionable items
- Stored in `extracted_tasks` table
- Shown in Dashboard, dismissable/completeable

### Idle Detection

- Track time since last screenshot capture
- Idle > 30min → trigger digest for the active period
- Max one digest per 4-hour block

## Out of scope

- Always-listening / wake word detection
- Cross-device sync
- Cloud storage of any kind
- Real-time interruptions ("you've been on Reddit too long")
- Hardware tier detection or model auto-selection
- Video recording (stays WebP screenshots only)

## Dependencies

| Dependency | Crate / Binary | Purpose |
|---|---|---|
| `rmcp` | Rust crate | MCP server protocol |
| `whisper-rs` | Rust crate (binds whisper.cpp) | Speech-to-text |
| `piper` | System binary | Text-to-speech |
| `claude` | System binary (Claude Code CLI) | Agentic AI path |

## Build order

1. **MCP server** — everything else depends on Claude Code having access to RewindOS data
2. **Chat routing** — wire Ask view to use Claude Code when available
3. **Voice STT** — whisper-rs integration + hotkey + mic capture
4. **Voice TTS** — Piper integration + audio playback
5. **Proactive** — deferred
