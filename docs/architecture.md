# RewindOS - Architecture Document

## Overview

RewindOS is a privacy-first, local-only screen capture and search tool for Linux/Wayland.
The MVP delivers: **automated screen capture → OCR indexing → full-text search**.

All data stays in `~/.rewindos/`. No network requests. No cloud.

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    User's Desktop                        │
│                                                          │
│  ┌──────────────────┐         ┌───────────────────────┐ │
│  │  rewindos-daemon  │◄─D-Bus─►│    Tauri UI (search)  │ │
│  │  (systemd user    │         │    React + shadcn/ui  │ │
│  │   service)        │         │                       │ │
│  └──────┬───────────┘         └───────────────────────┘ │
│         │                                                │
│         │ tokio channels                                 │
│         │                                                │
│  ┌──────▼───────────────────────────────────────┐       │
│  │            Internal Pipeline                   │       │
│  │                                                │       │
│  │  ┌─────────┐   ┌─────────┐   ┌────────────┐  │       │
│  │  │ Capture  │──►│  Hash   │──►│    OCR     │  │       │
│  │  │ (PipeWire│   │(dedup)  │   │ (Tesseract)│  │       │
│  │  │  portal) │   │         │   │            │  │       │
│  │  └─────────┘   └────┬────┘   └─────┬──────┘  │       │
│  │                      │              │          │       │
│  │                      ▼              ▼          │       │
│  │               ┌─────────────────────────┐     │       │
│  │               │   SQLite + FTS5          │     │       │
│  │               │   (~/.rewindos/          │     │       │
│  │               │    rewindos.db)          │     │       │
│  │               └─────────────────────────┘     │       │
│  └────────────────────────────────────────────────┘       │
│                                                          │
│  ┌──────────────────────────────────────────────┐       │
│  │  ~/.rewindos/screenshots/YYYY-MM-DD/*.webp   │       │
│  └──────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
```

## Cargo Workspace Layout

```
rewindos/
├── Cargo.toml                  # Workspace root
├── crates/
│   ├── rewindos-core/          # Shared library
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── db.rs           # SQLite + FTS5 operations
│   │       ├── schema.rs       # Database types & models
│   │       ├── ocr.rs          # Tesseract CLI wrapper
│   │       ├── hasher.rs       # Perceptual hashing (image-hasher)
│   │       ├── config.rs       # Config loading (config.toml)
│   │       ├── dbus_iface.rs   # Shared D-Bus interface definitions
│   │       └── migrations/     # refinery SQL migrations
│   │           └── V001__initial.sql
│   │
│   └── rewindos-daemon/        # Capture daemon (systemd service)
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs         # Entry point, D-Bus server, signal handlers
│           ├── capture.rs      # PipeWire portal screen capture
│           ├── pipeline.rs     # Tokio channel pipeline orchestration
│           ├── window_info.rs  # Active window metadata (multi-backend)
│           └── service.rs      # D-Bus service implementation
│
├── src-tauri/                  # Tauri UI application
│   ├── Cargo.toml              # Depends on rewindos-core
│   └── src/
│       ├── main.rs
│       ├── lib.rs              # Tauri commands
│       └── dbus_client.rs      # D-Bus client to talk to daemon
│
├── src/                        # React frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── SearchBar.tsx
│   │   ├── SearchResults.tsx
│   │   └── ScreenshotDetail.tsx
│   └── lib/
│       ├── api.ts              # Tauri invoke wrappers
│       └── types.ts            # TypeScript types matching Rust models
│
├── docs/                       # This documentation
├── migrations/                 # SQL migration source files
└── systemd/
    └── rewindos-daemon.service # systemd user unit file
```

## Component Details

### 1. rewindos-core (Shared Library)

The shared library that both the daemon and UI depend on.

**Responsibilities:**
- Database operations (CRUD, FTS5 search queries)
- Schema types / models (serde-serializable)
- Tesseract OCR wrapper (spawns `tesseract` CLI)
- Perceptual hashing (image-hasher crate)
- Configuration loading from `~/.rewindos/config.toml`
- Shared D-Bus interface definitions (zbus)
- Database migrations (refinery)

**Key Dependencies:**
- `rusqlite` (with `bundled` + `fts5` features)
- `image` + `image-hasher`
- `serde` + `serde_json` + `toml`
- `refinery` (migrations)
- `zbus` (D-Bus interface definitions)
- `chrono` (timestamps)
- `tokio` (async runtime, re-exported)
- `tracing` (structured logging)

### 2. rewindos-daemon (Capture Service)

Long-running systemd user service that captures the screen.

**Responsibilities:**
- xdg-desktop-portal ScreenCast session management
- PipeWire stream → frame extraction
- Pipeline orchestration via tokio channels
- D-Bus server exposing control interface
- Active window metadata collection
- Graceful shutdown on SIGTERM/SIGINT

**Pipeline Architecture (tokio channels):**

```
                    mpsc            mpsc             mpsc
 CaptureTask ──────────► HashTask ──────────► OcrTask ──────────► IndexTask
 (PipeWire)         (dedup filter)       (Tesseract)        (SQLite write)
```

Each stage runs as an independent tokio task:

1. **CaptureTask**: Grabs frames from PipeWire at configured interval (default 5s).
   Sends `RawFrame { pixels, timestamp, width, height }` to HashTask.

2. **HashTask**: Computes perceptual hash, compares to last N hashes.
   If hamming distance > threshold (5% change), forwards frame.
   Also saves WebP screenshot to disk and creates thumbnail.

3. **OcrTask**: Spawns `tesseract` CLI on the saved WebP file.
   Parses hOCR/TSV output for text + bounding boxes.
   Sends `OcrResult { screenshot_id, text, boxes }` to IndexTask.

4. **IndexTask**: Writes OCR text to SQLite FTS5 table.
   Updates screenshot record with OCR status.
   Runs in a dedicated thread (rusqlite is not async).

**Channel Configuration:**
- Bounded channels with backpressure (capacity: 32 per channel)
- If OCR falls behind, capture continues but OCR queue fills → backpressure to hash stage
- Metrics exposed via D-Bus (queue depths, frames processed/dropped)

**Window Info Detection (fallback chain):**
1. `wlr-foreign-toplevel-management-v1` Wayland protocol (most portable)
2. `org.kde.KWin` D-Bus interface (KDE-specific)
3. X11 `_NET_ACTIVE_WINDOW` via xcb (Xorg fallback)

### 3. Tauri UI (Search Application)

Desktop app for searching and browsing captures.

**Responsibilities:**
- Search interface (query → results list)
- Screenshot detail view
- Global hotkey registration (Ctrl+Shift+Space)
- D-Bus client to control daemon (pause/resume, status)
- System tray icon with quick controls

**Frontend Stack:**
- React 19 + TypeScript
- shadcn/ui + Tailwind CSS
- TanStack Query (search result caching)
- Tauri IPC (invoke Rust commands)

**Tauri Commands (Rust → JS bridge):**
- `search(query: String, filters: SearchFilters) → Vec<SearchResult>`
- `get_screenshot(id: i64) → ScreenshotDetail`
- `get_daemon_status() → DaemonStatus`
- `pause_capture() → ()`
- `resume_capture() → ()`
- `delete_range(start: DateTime, end: DateTime) → u64`

## D-Bus Interface

**Bus Name:** `com.rewindos.Daemon`
**Object Path:** `/com/rewindos/Daemon`
**Interface:** `com.rewindos.Daemon`

```xml
<interface name="com.rewindos.Daemon">
  <!-- Control Methods -->
  <method name="Pause" />
  <method name="Resume" />
  <method name="GetStatus">
    <arg name="status" type="s" direction="out" />
    <!-- Returns JSON: { "capturing": bool, "frames_today": u64,
         "queue_depth": u64, "uptime_secs": u64 } -->
  </method>

  <!-- Query Methods (UI uses these via Tauri backend) -->
  <method name="Search">
    <arg name="query" type="s" direction="in" />
    <arg name="filters_json" type="s" direction="in" />
    <arg name="results" type="s" direction="out" />
  </method>

  <!-- Signals -->
  <signal name="CaptureStateChanged">
    <arg name="is_capturing" type="b" />
  </signal>

  <!-- Properties -->
  <property name="IsCapturing" type="b" access="read" />
  <property name="CaptureInterval" type="u" access="readwrite" />
</interface>
```

**Note:** For the MVP, search queries go directly from Tauri → SQLite (both daemon and UI read the same DB file). The D-Bus Search method exists for CLI/external tool access but the UI uses direct DB queries for lower latency.

## Screen Capture Flow (xdg-desktop-portal → PipeWire)

```
1. Daemon starts
2. Connect to D-Bus session bus
3. Call org.freedesktop.portal.ScreenCast.CreateSession()
4. Call SelectSources(session, { types: MONITOR })
   → User sees compositor permission dialog (one-time)
5. Call Start(session)
   → Receive PipeWire node_id in response
6. Connect to PipeWire using node_id
7. Negotiate format (prefer BGRx/RGBx, 1920x1080 or native)
8. On each timer tick (5s default):
   a. Request single frame from PipeWire stream
   b. Convert pixel buffer to image::RgbaImage
   c. Send through pipeline channels
9. On Stop signal or SIGTERM:
   a. Close PipeWire stream
   b. Close portal session
   c. Flush pipeline channels
   d. Close database
```

**Rust crates for this:**
- `zbus` — D-Bus calls to xdg-desktop-portal
- `pipewire` (pipewire-rs) — PipeWire stream connection
- `image` — pixel buffer → WebP encoding

## File System Layout

```
~/.rewindos/
├── config.toml                    # User configuration
├── rewindos.db                    # SQLite database (FTS5)
├── screenshots/
│   └── YYYY-MM-DD/
│       ├── {unix_timestamp}.webp  # Full screenshots (~50-100KB each)
│       └── thumbs/
│           └── {unix_timestamp}.webp  # 320px wide thumbnails (~5-10KB)
└── logs/
    └── daemon.log                 # Structured log output
```

**Storage estimates (screenshots-only, no video):**
- 5s interval, 8 hours/day = 5,760 frames/day
- ~50% deduplication = ~2,880 unique frames/day
- At ~75KB average per WebP = ~210MB/day
- 90-day retention = ~19GB
- Thumbnails add ~10% overhead

## Configuration (config.toml)

```toml
[capture]
interval_seconds = 5
# Hamming distance threshold (0-64, lower = more sensitive)
change_threshold = 3
enabled = true

[storage]
base_dir = "~/.rewindos"
retention_days = 90
screenshot_quality = 80  # WebP quality (0-100)
thumbnail_width = 320

[privacy]
# Apps to never capture (matched against process name or window class)
excluded_apps = [
  "keepassxc",
  "1password",
  "bitwarden",
  "gnome-keyring",
]
# Patterns in window title to trigger auto-exclude
excluded_title_patterns = [
  "Private Browsing",
  "Incognito",
]

[ocr]
enabled = true
tesseract_lang = "eng"
# Max concurrent tesseract processes
max_workers = 2

[ui]
global_hotkey = "Ctrl+Shift+Space"
theme = "system"  # "light", "dark", "system"
```

## Error Handling Strategy

- **PipeWire disconnects**: Retry with exponential backoff (1s, 2s, 4s... max 60s). Log error, emit D-Bus signal.
- **Tesseract failures**: Log and skip frame. Don't block pipeline. Mark screenshot as `ocr_status = 'failed'`.
- **Disk full**: Check available space before each write. Pause capture and emit D-Bus signal if < 1GB free.
- **Permission denied (portal)**: Show notification via D-Bus desktop notifications. Log clearly.
- **Database corruption**: rusqlite WAL mode for crash safety. `PRAGMA integrity_check` on startup.

## Performance Constraints

| Metric | Target |
|---|---|
| CPU usage (idle capture) | < 5% |
| RAM baseline | < 200MB |
| Search latency (90 days) | < 100ms |
| Screenshot save time | < 50ms |
| OCR per frame | < 2s |
| Startup time (daemon) | < 1s |

## Security Considerations

- Database file permissions: 0600 (user-only read/write)
- Screenshot directory: 0700
- D-Bus interface only on session bus (user scope, not system)
- No network listeners (Tesseract runs locally)
- Config file: 0600
- Excluded apps list prevents capture of sensitive windows
