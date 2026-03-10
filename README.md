# RewindOS

Privacy-first, local-only screen capture and search for Linux. Continuously captures your screen, extracts text via OCR, and lets you instantly search through everything you've seen. All data stays on your machine.

## How it works

A background daemon captures screenshots every 5 seconds, deduplicates them with perceptual hashing, runs OCR via Tesseract, and indexes the extracted text into SQLite FTS5. A Tauri desktop app provides search, browsing, journaling, and analytics.

```
Timer (5s) → Screen Capture → Hash & Dedupe → OCR → SQLite FTS5
```

## Features

- **Full-text search** across everything on your screen with sub-100ms queries
- **Hybrid search** — keyword + semantic search via Ollama with Reciprocal Rank Fusion (optional)
- **Intelligent deduplication** — perceptual hashing skips near-identical frames, scene grouping in search results
- **Timeline browsing** — scroll through screen history chronologically with hourly grouping
- **Rewind playback** — timelapse player with scrubber, speed controls, and keyboard navigation
- **Dashboard** — activity overview, app usage stats, daily/hourly charts, heatmap calendar
- **AI chat** — ask questions about your screen history with intent detection and screenshot references (Ollama)
- **Journaling** — rich text editor (Tiptap) with tags, templates, screenshot attachments, AI summaries, and export
- **Bookmarks & collections** — save and organize screenshots into named collections
- **Focus mode** — Pomodoro timer with productivity tracking and distraction detection
- **Privacy controls** — exclude specific apps or window title patterns
- **Global hotkey** — `Ctrl+Shift+Space` to instantly open search
- **System tray** — runs quietly in the background

## Target platform

Linux (Wayland) — KDE Plasma 6+, GNOME, Hyprland, Sway.

## Prerequisites

```bash
sudo apt install \
  libpipewire-0.3-dev \
  tesseract-ocr tesseract-ocr-eng \
  libclang-dev libsqlite3-dev \
  libdbus-1-dev pkg-config build-essential
```

Optional: [Ollama](https://ollama.com) for AI features (semantic search, chat, journal summaries).

## Build & install

```bash
make install
```

This builds the Rust workspace and frontend, installs the daemon as a systemd user service, and sets up the desktop app to autostart minimized to tray on login.

### Manual build

```bash
cargo build --workspace       # Rust crates
bun install                   # Frontend deps
bun run tauri dev             # Run in dev mode
```

## Usage

After installation, the daemon starts automatically. The UI autostarts minimized to the system tray.

- **Open search**: `Ctrl+Shift+Space`
- **View logs**: `make logs`
- **Restart daemon**: `make restart-daemon`
- **Launch UI manually**: `rewindos`
- **Daemon CLI**: `rewindos-daemon pause | resume | status | backfill`

## Project layout

```
crates/rewindos-core/     Shared lib (DB, OCR, hashing, config, embedding, chat)
crates/rewindos-daemon/   Capture daemon (PipeWire, pipeline, D-Bus, window info)
src-tauri/                Tauri app (commands, D-Bus client, AI chat)
src/                      React frontend
  components/             Reusable UI components (search, charts, shared)
  features/               Feature views (ask, dashboard, history, journal, rewind, saved, focus, settings)
  hooks/                  Custom React hooks
  context/                React context providers
  lib/                    API wrappers, utilities, query keys
docs/                     Architecture & design docs
systemd/                  Service files and desktop entries
```

## Storage

At default settings (~5s interval, 8h/day):

| Metric | Estimate |
|---|---|
| Frames/day (after dedup) | ~2,880 |
| Storage/day | ~210 MB |
| 90-day retention | ~19 GB |

Screenshots are stored as WebP in `~/.rewindos/`. Retention is configurable.

## Configuration

Config lives at `~/.rewindos/config.toml`. Key options:

- **Capture interval** and change sensitivity threshold
- **Excluded apps** and window title patterns (e.g. password managers, private browsing)
- **Retention period** and storage limits
- **OCR language** and worker count
- **Ollama endpoint** for AI features (semantic search, chat, summaries)
- **Focus mode** — Pomodoro timer durations, distraction apps

## License

MIT
