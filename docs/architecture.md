# RewindOS - Architecture Document

## Overview

RewindOS is a privacy-first, local-only screen capture and search tool for Linux/Wayland.
Core flow: **automated screen capture → OCR indexing → full-text search**, with optional **semantic search** and **AI chat** via Ollama.

All data stays in `~/.rewindos/`. No network requests except optional local Ollama (localhost:11434).

## System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        User's Desktop                             │
│                                                                   │
│  ┌──────────────────┐           ┌───────────────────────────────┐│
│  │  rewindos-daemon  │◄──D-Bus──►│       Tauri UI                ││
│  │  (systemd user    │           │   React 19 + shadcn/ui        ││
│  │   service)        │           │                               ││
│  └──────┬───────────┘           │  Search │ History │ Dashboard  ││
│         │                        │  Ask    │ Focus  │ Settings   ││
│         │ tokio channels         └───────────────────────────────┘│
│         │                                                         │
│  ┌──────▼──────────────────────────────────────────────┐         │
│  │              Internal Pipeline                        │         │
│  │                                                       │         │
│  │  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌────────┐│         │
│  │  │ Capture  │─►│  Hash   │─►│   OCR    │─►│ Index  ││         │
│  │  │(PipeWire │  │ (dedup) │  │(Tesseract│  │(SQLite)││         │
│  │  │ portal)  │  │         │  │          │  │        ││         │
│  │  └─────────┘  └─────────┘  └──────────┘  └────────┘│         │
│  └──────────────────────┬────────────────────────────────┘         │
│                          │                                         │
│                          ▼                                         │
│  ┌──────────────────────────────────────────────┐                 │
│  │  SQLite + FTS5 + sqlite-vec                   │                 │
│  │  (~/.rewindos/rewindos.db)                    │                 │
│  │                                                │                 │
│  │  Keyword search (FTS5 MATCH)                  │                 │
│  │  Vector search (sqlite-vec KNN)               │                 │
│  │  Hybrid search (Reciprocal Rank Fusion)       │                 │
│  │  Scene dedup (perceptual hash grouping)       │                 │
│  └──────────────────────────────────────────────┘                 │
│                                                                   │
│  ┌──────────────────────────┐  ┌────────────────────────┐        │
│  │ screenshots/YYYY-MM-DD/  │  │  Ollama (optional)      │        │
│  │   *.webp + thumbs/*.webp │  │  nomic-embed-text       │        │
│  └──────────────────────────┘  │  qwen2.5:3b (chat)      │        │
│                                 └────────────────────────┘        │
└──────────────────────────────────────────────────────────────────┘
```

## Cargo Workspace Layout

```
rewindos/
├── Cargo.toml                  # Workspace root
├── crates/
│   ├── rewindos-core/          # Shared library
│   │   ├── Cargo.toml
│   │   ├── migrations/
│   │   │   ├── V001__initial_schema.sql
│   │   │   └── V002__vector_embeddings.sql
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── db.rs           # SQLite + FTS5 + vector + hybrid search + scene dedup
│   │       ├── schema.rs       # Database types & models
│   │       ├── ocr.rs          # Tesseract CLI wrapper
│   │       ├── hasher.rs       # Perceptual hashing (image-hasher)
│   │       ├── config.rs       # Config loading (config.toml)
│   │       ├── embedding.rs    # OllamaClient (embeddings, model management)
│   │       ├── chat.rs         # OllamaChatClient (AI chat, intent detection)
│   │       └── error.rs        # Error types (thiserror)
│   │
│   └── rewindos-daemon/        # Capture daemon (systemd service)
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs         # Entry point, D-Bus server, Ollama auto-detect, backfill
│           ├── capture/        # PipeWire portal screen capture (multi-backend)
│           ├── pipeline.rs     # Tokio channel pipeline orchestration
│           ├── window_info/    # Active window metadata (wlr-toplevel, KWin, X11)
│           ├── service.rs      # D-Bus service implementation
│           └── detect.rs       # Desktop/session environment detection
│
├── src-tauri/                  # Tauri UI application
│   ├── Cargo.toml
│   └── src/
│       └── lib.rs              # Tauri commands + D-Bus client
│
├── src/                        # React frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── SearchBar.tsx       # Search input with filters
│   │   ├── SearchResults.tsx   # Result container with grid/list toggle
│   │   ├── SearchResultGrid.tsx  # Grid view with "+N similar" badges
│   │   ├── SearchResultCard.tsx  # List view with dedup badges
│   │   ├── SemanticBadge.tsx   # "ai search" / "keyword" mode indicator
│   │   ├── ScreenshotDetail.tsx  # Full screenshot + OCR text viewer
│   │   ├── HistoryView.tsx     # Chronological screenshot browser
│   │   ├── TimelineView.tsx    # Visual timeline with hourly/daily view
│   │   ├── DashboardView.tsx   # Analytics dashboard with charts
│   │   ├── AskView.tsx         # AI chat interface
│   │   ├── ChatMessage.tsx     # Chat message with streaming + screenshot refs
│   │   ├── FocusView.tsx       # Pomodoro timer with productivity tracking
│   │   ├── SettingsView.tsx    # Full config UI
│   │   ├── Sidebar.tsx         # View navigation
│   │   └── ...                 # Supporting components
│   └── lib/
│       ├── api.ts              # Tauri invoke wrappers + TypeScript types
│       └── format.ts           # Date/time formatting utilities
│
├── docs/                       # Documentation
└── systemd/
    └── rewindos-daemon.service
```

## Component Details

### 1. rewindos-core (Shared Library)

The shared library that both the daemon and UI depend on.

**Responsibilities:**
- Database operations (CRUD, FTS5 search, vector search, hybrid search, scene dedup)
- Schema types / models (serde-serializable)
- Tesseract OCR wrapper (spawns `tesseract` CLI)
- Perceptual hashing (image-hasher crate)
- Configuration loading from `~/.rewindos/config.toml`
- OllamaClient for embeddings (health check, model management, embed)
- OllamaChatClient for AI chat (intent detection, streaming, context building)
- Database migrations (refinery)

**Key Dependencies:**
- `rusqlite` (with `bundled` + `fts5` features)
- `sqlite-vec` (vector similarity search extension)
- `image` + `image-hasher`
- `serde` + `serde_json` + `toml`
- `refinery` (migrations)
- `reqwest` (Ollama HTTP client)
- `chrono` (timestamps)
- `tokio` (async runtime)
- `tracing` (structured logging)

### 2. rewindos-daemon (Capture Service)

Long-running systemd user service that captures the screen.

**Responsibilities:**
- xdg-desktop-portal ScreenCast session management
- PipeWire stream → frame extraction
- Pipeline orchestration via tokio channels
- D-Bus server exposing control interface
- Active window metadata collection
- Ollama auto-detection and model pulling on startup
- Background embedding backfill
- Graceful shutdown on SIGTERM/SIGINT

**Pipeline Architecture (tokio channels):**

```
                    mpsc            mpsc             mpsc
 CaptureTask ──────────► HashTask ──────────► OcrTask ──────────► IndexTask
 (PipeWire)         (dedup filter)       (Tesseract)        (SQLite write)
```

Each stage runs as an independent tokio task. See `docs/capture-pipeline.md` for details.

**Daemon Startup Sequence:**
1. Load config, ensure directories
2. Check tesseract availability
3. Open database, run migrations
4. **Ollama auto-detection**: probe health → check model → pull if missing → enable semantic
5. Start capture pipeline
6. **Spawn background backfill** (if Ollama available): batch 50, 50ms delay between embeddings
7. Register D-Bus service
8. Start window info provider
9. Wait for shutdown signal

**Window Info Detection (fallback chain):**
1. `wlr-foreign-toplevel-management-v1` Wayland protocol (Hyprland, Sway, etc.)
2. `org.kde.KWin` D-Bus interface (KDE Plasma)
3. X11 `_NET_ACTIVE_WINDOW` via xcb (Xorg fallback)

### 3. Tauri UI (Search Application)

Desktop app for searching, browsing, chatting, and analytics.

**Frontend Stack:**
- React 19 + TypeScript
- shadcn/ui + Tailwind CSS
- TanStack Query (data caching)
- Tauri IPC (invoke Rust commands)

**Views:**
- **Search** — Full-text + semantic search with grid/list toggle, scene dedup badges
- **History** — Chronological screenshot browser with timeline scrubbing
- **Dashboard** — App usage analytics, daily/hourly activity charts
- **Ask** — AI chat with intent detection and screenshot references
- **Focus** — Pomodoro timer with productivity tracking and distraction detection
- **Settings** — Full configuration UI for all sections

## Search Architecture

### Three Search Modes

1. **Keyword-only** (no Ollama): FTS5 MATCH → scene dedup → paginate
2. **Hybrid** (Ollama available): FTS5 + sqlite-vec KNN → RRF fusion → scene dedup → paginate
3. Search mode is always reported in response (`search_mode: "keyword" | "hybrid"`)

### Scene Deduplication

Post-search grouping to collapse near-duplicate screenshots:

1. Over-fetch raw results (limit × 3, max 300)
2. Batch fetch perceptual hashes for all result IDs
3. Greedy grouping: iterate in rank order, assign each to first group where hamming distance ≤ 5
4. Representative (best-ranked) gets `group_count` and `group_screenshot_ids`
5. Paginate the deduped set

### Hybrid Search (Reciprocal Rank Fusion)

When Ollama is available:
1. FTS5 keyword search → up to 300 results
2. sqlite-vec KNN vector search → up to 300 results
3. RRF fusion (k=60): score each result by 1/(k + rank + 1) from both lists
4. Sort by combined score descending
5. Apply scene dedup
6. Paginate

### Ollama Auto-Detection

On daemon startup (regardless of `semantic.enabled` config):
1. Health check Ollama at configured URL (default: localhost:11434)
2. If reachable: check if embedding model exists via `/api/tags`
3. If model missing: pull via `/api/pull` (10-minute timeout)
4. If model available: enable semantic search, spawn background backfill
5. If unreachable: continue with keyword-only search (no error, graceful degradation)

## D-Bus Interface

**Bus Name:** `com.rewindos.Daemon`
**Object Path:** `/com/rewindos/Daemon`
**Interface:** `com.rewindos.Daemon`

See `docs/dbus-api.md` for full contract.

## File System Layout

```
~/.rewindos/
├── config.toml                    # User configuration
├── rewindos.db                    # SQLite database (FTS5 + sqlite-vec)
├── screenshots/
│   └── YYYY-MM-DD/
│       ├── {timestamp_ms}.webp    # Full screenshots (~50-100KB each)
│       └── thumbs/
│           └── {timestamp_ms}.webp  # 320px wide thumbnails (~5-10KB)
└── logs/
    └── daemon.log
```

## Configuration (config.toml)

```toml
[capture]
interval_seconds = 5
change_threshold = 3
enabled = true

[storage]
base_dir = "~/.rewindos"
retention_days = 90
screenshot_quality = 80
thumbnail_width = 320

[privacy]
excluded_apps = ["keepassxc", "1password", "bitwarden", "gnome-keyring"]
excluded_title_patterns = ["Private Browsing", "Incognito"]

[ocr]
enabled = true
tesseract_lang = "eng"
max_workers = 2

[ui]
global_hotkey = "Ctrl+Shift+Space"
theme = "system"

[semantic]
enabled = false           # Auto-enabled at runtime if Ollama detected
ollama_url = "http://localhost:11434"
model = "nomic-embed-text"
embedding_dimensions = 768

[chat]
enabled = true
ollama_url = "http://localhost:11434"
model = "qwen2.5:3b"
max_context_tokens = 4096
max_history_messages = 20
temperature = 0.3

[focus]
work_minutes = 25
short_break_minutes = 5
long_break_minutes = 15
sessions_before_long_break = 4
daily_goal_minutes = 480
distraction_apps = ["discord", "slack", "twitter", "reddit"]
auto_start_breaks = true
auto_start_work = false
```

## Error Handling Strategy

- **PipeWire disconnects**: Retry with exponential backoff (1s, 2s, 4s... max 60s)
- **Tesseract failures**: Log and skip frame. Mark screenshot as `ocr_status = 'failed'`
- **Disk full**: Check available space before each write. Pause capture if < 1GB free
- **Ollama unavailable**: Graceful degradation to keyword-only search
- **Embedding failures**: Log and continue. Screenshot still searchable via FTS5
- **Database corruption**: rusqlite WAL mode for crash safety

## Security Considerations

- Database file permissions: 0600 (user-only read/write)
- Screenshot directory: 0700
- D-Bus interface only on session bus (user scope, not system)
- Ollama connection is localhost-only (no external network)
- Excluded apps list prevents capture of sensitive windows
