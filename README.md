# RewindOS

Privacy-first, local-only screen capture and search for Linux. Continuously captures your screen, extracts text via OCR, and lets you instantly search through everything you've seen. All data stays on your machine.

## How it works

A background daemon captures screenshots every 5 seconds, deduplicates them with perceptual hashing, runs OCR via Tesseract, and indexes the extracted text into SQLite FTS5. A Tauri desktop app provides the search UI.

```
Timer (5s) → Screen Capture → Hash & Dedupe → OCR → SQLite FTS5
```

## Features

- **Full-text search** across everything on your screen with sub-100ms queries
- **Intelligent deduplication** — perceptual hashing skips near-identical frames
- **Privacy controls** — exclude specific apps or window title patterns
- **AI-powered search** — semantic search and chat with your screen history via Ollama (optional)
- **Dashboard** — activity overview, app usage stats, daily summaries
- **Timeline browsing** — scroll through your screen history chronologically
- **Global hotkey** — `Ctrl+Shift+Space` to instantly open search
- **System tray** — runs quietly in the background

## Target platform

KDE Plasma 6+ on Ubuntu 24.04+ (Wayland).

## Prerequisites

```bash
sudo apt install \
  libpipewire-0.3-dev \
  tesseract-ocr tesseract-ocr-eng \
  libclang-dev libsqlite3-dev \
  libdbus-1-dev pkg-config build-essential
```

Optional: [Ollama](https://ollama.com) for AI features (semantic search, chat).

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
- **Daemon CLI**: `rewindos-daemon pause | resume | status`

## Project layout

```
crates/rewindos-core/     Shared lib (DB, OCR, hashing, config)
crates/rewindos-daemon/   Capture daemon (PipeWire, pipeline, D-Bus)
src-tauri/                Tauri app (search commands, D-Bus client)
src/                      React frontend
docs/                     Architecture & design docs
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
- **Ollama endpoint** for AI features

## License

MIT
