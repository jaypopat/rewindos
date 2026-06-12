# RewindOS

**Search everything you've ever seen on your screen — and keep it 100% on your machine.**

RewindOS continuously captures your screen, reads the text on it with OCR, and indexes it for instant full-text (and optional semantic) search. A private, local "rewind" for Linux: **no cloud, no account, no telemetry — it runs entirely offline.**

<!-- TODO: drop a short demo GIF here (searching for something you saw last week). A GIF converts far better than a static shot. -->

<img width="2876" height="1650" alt="image" src="https://github.com/user-attachments/assets/210ae7b4-6995-4190-b64d-d9961583433e" />

<img width="2866" height="1647" alt="image" src="https://github.com/user-attachments/assets/ed92dd18-2a47-491d-abbf-281bb1bc064d" />


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
- **AI chat** — ask questions about your screen history with inline citations, a Sources card, and click-through to cited screenshots. Backed by Claude Code (opus / sonnet / haiku) or local Ollama via a per-chat model picker. Pin screenshots as prompt context, copy or regenerate replies, and get follow-up suggestions (Ollama).
- **Journaling** — rich text editor (Tiptap) with tags, templates, screenshot attachments, AI summaries, and export
- **Bookmarks & collections** — save and organize screenshots into named collections
- **Vault export** — daily memory notes (journal, recap, meetings, key moments, stats) written into your Obsidian or Logseq vault
- **Focus mode** — Pomodoro timer with productivity tracking and distraction detection
- **Privacy controls** — exclude specific apps or window title patterns
- **Global hotkey** — `Ctrl+Shift+Space` to instantly open search
- **System tray** — runs quietly in the background

## Platform support

Linux on **Wayland**. Capture uses `xdg-desktop-portal` + PipeWire, so it works on any compositor that implements the ScreenCast portal.

| Desktop | Status |
|---|---|
| KDE Plasma 6+ | ✅ Tested |
| GNOME 46+ | ✅ Tested — install the "Window Calls Extended" extension for app/window names |
| Hyprland · Sway · other wlroots | ⚠️ Should work via the portal — not yet verified |

x86_64 only for prebuilt binaries. X11-only sessions aren't supported.

## Install

### Arch Linux

```bash
yay -S rewindos-bin     # or: paru -S rewindos-bin
systemctl --user enable --now rewindos-daemon.service
```

### Other distros

RewindOS is local-first and privacy-focused, so the recommended install is **download, read, then run**:

```bash
curl -fsSL https://raw.githubusercontent.com/jaypopat/rewindos/master/install.sh -o install.sh
less install.sh          # read what it does
bash install.sh
```

Prefer a one-liner? (Same script, run directly.)

```bash
curl -fsSL https://raw.githubusercontent.com/jaypopat/rewindos/master/install.sh | bash
```

The installer detects your distro, installs the system dependencies (Tesseract, PipeWire, the webview, and the right desktop portal), downloads and **checksum-verifies** the latest release, and enables the capture daemon as a systemd user service.

**Options**

```bash
bash install.sh --with-paddleocr   # higher-accuracy OCR (heavier Python deps)
bash install.sh --update           # update to the latest release
bash install.sh --uninstall        # remove RewindOS (asks before deleting your data)
```

**Requirements:** x86_64, a modern Wayland desktop (KDE, GNOME, Hyprland, Sway), and a current distro. The prebuilt binary targets recent glibc + `webkit2gtk-4.1`; on older distros, build from source.

## Optional: AI features

These are off by default; RewindOS works fully without them.

- [Ollama](https://ollama.com) — local semantic search, chat, and journal summaries (everything stays on-device).
- Claude Code CLI — higher-quality chat; once installed and registered with MCP, the Ask view's model picker exposes its tiers (opus / sonnet / haiku).

## Build from source

The `install.sh` path above installs system dependencies for you — this section is only if you'd rather build it yourself.

```bash
sudo apt install \
  libpipewire-0.3-dev \
  tesseract-ocr tesseract-ocr-eng \
  libclang-dev libsqlite3-dev \
  libdbus-1-dev pkg-config build-essential
```

```bash
make install
```

This builds the Rust workspace and frontend, installs the daemon as a systemd user service, and sets up the desktop app to autostart minimized to tray on login.

### Manual / dev build

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
