# RewindOS - Development Context

## What is this?
Privacy-first, local-only screen capture and search tool for Linux/Wayland.
Core flow: capture → OCR → full-text search, with optional semantic search via Ollama.

## Architecture Decisions (locked in)
- **Capture**: xdg-desktop-portal → PipeWire stream (zbus + pipewire-rs)
- **OCR**: Tesseract CLI subprocess (upgrade to PaddleOCR post-MVP)
- **Storage**: WebP screenshots only (no video)
- **Database**: SQLite + FTS5 + sqlite-vec (rusqlite, bundled)
- **Migrations**: refinery with embedded SQL
- **Pipeline**: 4 tokio tasks connected by bounded mpsc channels (capture → hash → ocr → index)
- **Daemon**: Separate systemd user service (rewindos-daemon)
- **IPC**: D-Bus session bus (zbus) — com.rewindos.Daemon
- **Hashing**: image-hasher crate (gradient hash, 8x8)
- **Window info**: wlr-foreign-toplevel → KWin D-Bus → X11 fallback
- **Frontend**: React 19 + shadcn/ui + Tailwind CSS + TanStack Query
- **Global hotkey**: Ctrl+Shift+Space
- **Package manager**: Bun
- **Semantic search**: Ollama + nomic-embed-text → sqlite-vec → hybrid search (RRF)
- **Scene dedup**: Post-search grouping by perceptual hash hamming distance (≤ 5)
- **Chat**: Ollama (qwen2.5:3b) with intent detection and screenshot context

## Project Layout (Cargo workspace)
- `crates/rewindos-core/` — shared lib (DB, OCR, hashing, config, embedding, chat, types)
- `crates/rewindos-daemon/` — capture daemon (PipeWire, pipeline, D-Bus server)
- `src-tauri/` — Tauri UI app (search commands, D-Bus client)
- `src/` — React frontend

## Key Modules (rewindos-core)
- `db.rs` — SQLite + FTS5 + vector search, hybrid search (RRF), scene deduplication
- `schema.rs` — All shared types (Screenshot, SearchResult, SearchResponse, etc.)
- `embedding.rs` — OllamaClient (embed, health_check, has_model, pull_model)
- `chat.rs` — OllamaChatClient, intent detection, streaming chat with screenshot context
- `hasher.rs` — Perceptual hashing, hamming distance, WebP save, thumbnails
- `ocr.rs` — Tesseract CLI wrapper, TSV parsing
- `config.rs` — Config loading (SemanticConfig, ChatConfig, FocusConfig, etc.)

## Key Documentation
- `docs/architecture.md` — Full system architecture
- `docs/database-schema.md` — SQLite schema + queries
- `docs/dbus-api.md` — D-Bus interface contract
- `docs/capture-pipeline.md` — Pipeline deep dive with data types
- `docs/frontend-spec.md` — UI layout, components, Tauri IPC

## Search Architecture
1. **Keyword search**: FTS5 MATCH with snippet highlighting
2. **Hybrid search**: FTS5 + sqlite-vec KNN, fused with Reciprocal Rank Fusion (k=60)
3. **Scene dedup**: Post-search grouping — over-fetch 3x, group by hamming distance ≤ 5, paginate deduped set
4. **Auto-detection**: Daemon probes Ollama on startup, pulls model if missing, enables semantic transparently

## Frontend Views
- **Search** — Full-text search with grid/list toggle, scene dedup badges, SemanticBadge
- **History** — Chronological screenshot browser with timeline
- **Dashboard** — Activity charts, app usage stats, daily/hourly breakdowns
- **Ask** — AI chat with intent detection and screenshot references
- **Focus** — Pomodoro timer with productivity tracking
- **Settings** — Full config UI (capture, privacy, semantic, chat, focus)

## Target Platform
Linux (Wayland) — KDE Plasma, GNOME, Hyprland, Sway

## System Dependencies
```bash
sudo apt install libpipewire-0.3-dev tesseract-ocr tesseract-ocr-eng libclang-dev libdbus-1-dev pkg-config build-essential
```

## Build Commands
```bash
cargo build --workspace          # Build all Rust crates
cargo test -p rewindos-core      # Run core tests (includes dedup tests)
bun install                      # Install frontend deps
bun run tauri dev                # Run Tauri app in dev mode
cargo run -p rewindos-daemon     # Run capture daemon directly
cargo run -p rewindos-daemon -- backfill  # Backfill embeddings manually
```
