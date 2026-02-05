# RewindOS - MVP Task Breakdown

## MVP Definition

**Scope:** Automated screen capture → OCR indexing → full-text search with results list.

**What's IN:**
- PipeWire screen capture via xdg-desktop-portal
- Perceptual hash deduplication
- WebP screenshot storage
- Tesseract OCR (CLI subprocess)
- SQLite FTS5 search
- Search UI (search bar + list results)
- Active window metadata capture
- Global hotkey (Ctrl+Shift+Space)
- D-Bus daemon with pause/resume
- systemd user service
- Basic privacy controls (app exclusion list in config)

**What's OUT (post-MVP):**
- Timeline view / scrubbing
- Analytics dashboard / charts
- Video compression (H.264)
- AI/semantic search (Ollama)
- Multi-monitor support
- System tray icon with menu
- Settings UI (config.toml only for MVP)
- Data retention auto-cleanup (manual only for MVP)

---

## Phase 0: Project Setup (Foundation)

### T0.1 — Restructure into Cargo workspace
- Create `Cargo.toml` at repo root as workspace
- Create `crates/rewindos-core/` with Cargo.toml and `src/lib.rs`
- Create `crates/rewindos-daemon/` with Cargo.toml and `src/main.rs`
- Update `src-tauri/Cargo.toml` to be workspace member, depend on `rewindos-core`
- Verify `cargo build --workspace` succeeds
- Verify `bun run tauri dev` still launches the app

### T0.2 — Add shared dependencies
- Add to rewindos-core: `rusqlite` (bundled, fts5), `image`, `image-hasher`, `serde`, `serde_json`, `toml`, `chrono`, `tokio`, `tracing`, `tracing-subscriber`, `zbus`, `refinery`
- Add to rewindos-daemon: depends on `rewindos-core`, plus `pipewire` (pipewire-rs), `tokio` (full), `zbus`
- Add to src-tauri: depends on `rewindos-core`, plus `zbus`
- Verify everything compiles (system deps: `libpipewire-0.3-dev`, `libtesseract-dev`, `libclang-dev`)

### T0.3 — Frontend tooling setup
- Install Tailwind CSS 4 + configure with Vite
- Install and configure shadcn/ui (init, add basic components: Input, Button, ScrollArea, Card)
- Remove default Tauri greeting demo (App.tsx, App.css)
- Create minimal app shell with search layout placeholder
- Verify `bun run tauri dev` shows the new UI

### T0.4 — File system and config bootstrap
- Implement `config.rs` in rewindos-core: load/create `~/.rewindos/config.toml`
- Create default config with all fields documented
- Implement directory creation (`screenshots/`, `logs/`, `thumbs/` per-day dirs)
- Add `tracing-subscriber` setup for file + stdout logging
- Unit test: config loads defaults when file missing, parses when present

---

## Phase 1: Database Layer

### T1.1 — SQLite connection and migrations
- Implement `db.rs` in rewindos-core: connection pool (single writer, multiple readers via WAL)
- Set PRAGMAs on connection (WAL, synchronous=NORMAL, foreign_keys, busy_timeout, cache_size)
- Add refinery migration runner
- Write `V001__initial_schema.sql` with all tables from database-schema.md
- Test: migration runs on empty DB, is idempotent on existing DB

### T1.2 — Database CRUD operations
- `insert_screenshot(metadata) → i64` (returns ID)
- `insert_ocr_text(screenshot_id, text, boxes)` (FTS5 content + bounding boxes)
- `update_ocr_status(screenshot_id, status)`
- `get_screenshot(id) → Screenshot`
- `get_recent_hashes(since_timestamp, limit) → Vec<(i64, Vec<u8>)>`
- `delete_screenshots_before(timestamp) → u64` (with file cleanup callback)
- All operations with proper error types (thiserror)
- Unit tests with in-memory SQLite

### T1.3 — Full-text search implementation
- `search(query, filters) → Vec<SearchResult>` with:
  - FTS5 MATCH query
  - Optional date range filter (start_time, end_time)
  - Optional app_name filter
  - Snippet generation with highlight markers
  - Pagination (limit + offset)
  - Result count
- Benchmark: search over 100k test rows < 100ms
- Unit tests: exact match, phrase search, partial match, no results, filters

### T1.4 — Schema types and serialization
- Define Rust structs in `schema.rs`: `Screenshot`, `OcrResult`, `SearchResult`, `SearchFilters`, `DaemonStatus`, `AppConfig`
- Derive `serde::Serialize` + `serde::Deserialize` on all types
- These types are shared between daemon, core, and Tauri commands
- Ensure all timestamps use `chrono::DateTime<Utc>` or Unix timestamps consistently

---

## Phase 2: Capture Pipeline

### T2.1 — xdg-desktop-portal ScreenCast session
- Implement `capture.rs` in rewindos-daemon
- Use `zbus` to call `org.freedesktop.portal.ScreenCast`:
  1. `CreateSession()` → session handle
  2. `SelectSources(session, types=MONITOR)` → user picks monitor
  3. `Start(session)` → get PipeWire `node_id`
- Handle permission dialog (user must approve)
- Handle session closed signal (reconnect)
- Integration test: successfully get a PipeWire node_id on KDE Plasma

### T2.2 — PipeWire frame capture
- Connect to PipeWire using `node_id` from portal
- Negotiate video format (prefer BGRx or RGBx, native resolution)
- Implement frame grabbing on timer (configurable interval, default 5s)
- Convert PipeWire buffer → `image::RgbaImage`
- Send `RawFrame` through tokio mpsc channel
- Handle PipeWire disconnects with reconnection logic
- Integration test: capture 10 frames, verify they're valid images

### T2.3 — Perceptual hashing and deduplication
- Implement `hasher.rs` in rewindos-core
- Use `image-hasher` crate with `HasherConfig::new().hash_size(8, 8).hash_alg(HashAlg::Gradient)`
- Compute hash from `RgbaImage`
- Compare hamming distance against recent hashes from DB
- If distance <= threshold (configurable, default 3): skip frame, send nothing downstream
- If distance > threshold: save WebP to disk, create thumbnail, forward to OCR stage
- Unit tests: identical images → distance 0, similar → low distance, different → high distance
- WebP encoding with configurable quality (default 80)
- Thumbnail generation (320px wide, proportional height)

### T2.4 — Active window metadata
- Implement `window_info.rs` in rewindos-daemon
- Fallback chain:
  1. Try `wlr-foreign-toplevel-management-v1` Wayland protocol
  2. Try `org.kde.KWin` D-Bus (`activeWindow` property)
  3. Try X11 `_NET_ACTIVE_WINDOW` via xcb
- Return `WindowInfo { app_name, window_title, window_class }`
- Check excluded_apps list from config before capture (skip if excluded)
- Log which backend was selected on startup
- Integration test on KDE: returns correct app name + title

### T2.5 — Pipeline orchestration
- Implement `pipeline.rs` in rewindos-daemon
- Create tokio mpsc channels (bounded, capacity 32):
  - `capture_tx/rx`: RawFrame
  - `hash_tx/rx`: HashedFrame (with screenshot ID, file path)
  - `ocr_tx/rx`: OcrResult
- Spawn 4 tokio tasks:
  1. **Capture loop**: timer + PipeWire frame grab → capture_tx
  2. **Hash task**: capture_rx → dedup check → save to disk → hash_tx
  3. **OCR task**: hash_rx → spawn tesseract → ocr_tx
  4. **Index task**: ocr_rx → SQLite write (spawn_blocking for rusqlite)
- Graceful shutdown: close channels in order, flush pending work
- Metrics tracking: frames captured, deduplicated, OCR'd, indexed
- Integration test: feed 5 test images through pipeline, verify DB contains results

---

## Phase 3: OCR Integration

### T3.1 — Tesseract CLI wrapper
- Implement `ocr.rs` in rewindos-core
- Spawn `tesseract <input.webp> stdout --oem 1 --psm 3 -l eng tsv`
- Parse TSV output: extract text, confidence, and bounding box (x, y, w, h)
- Concatenate words into full text (space-separated, newline on line breaks)
- Filter low-confidence results (< 30%)
- Timeout: kill process after 10s
- Handle missing `tesseract` binary gracefully (log error, mark as failed)
- Unit test with known screenshot → expected text extraction
- Respect `max_workers` config (semaphore limiting concurrent tesseract processes)

### T3.2 — OCR pipeline integration
- Wire OCR task into pipeline (receives WebP path, returns OcrResult)
- Semaphore-bounded concurrency (default: 2 concurrent tesseract processes)
- On failure: log, mark screenshot as `ocr_status = 'failed'`, continue
- On success: insert into ocr_text_content (triggers FTS5 sync), update ocr_status
- Batch bounding boxes insert
- Integration test: capture → hash → OCR → verify searchable text in DB

---

## Phase 4: D-Bus Service & Daemon

### T4.1 — D-Bus service implementation
- Implement `service.rs` in rewindos-daemon
- Register `com.rewindos.Daemon` on session bus
- Methods:
  - `Pause()` — pause capture loop (channel signal)
  - `Resume()` — resume capture loop
  - `GetStatus()` — return JSON with: is_capturing, frames_today, queue_depths, uptime
- Properties:
  - `IsCapturing` (bool, read)
  - `CaptureInterval` (u32, read/write)
- Signals:
  - `CaptureStateChanged(bool)`
- Integration test: start daemon, call Pause/Resume via busctl, verify state changes

### T4.2 — Daemon main and systemd integration
- Implement `main.rs` for rewindos-daemon:
  1. Load config
  2. Initialize logging (file + stdout)
  3. Run migrations
  4. Start D-Bus service
  5. Start capture pipeline
  6. Wait for SIGTERM/SIGINT (tokio signal)
  7. Graceful shutdown
- Create `systemd/rewindos-daemon.service` user unit file
- Install instructions: `systemctl --user enable rewindos-daemon`
- Test: `systemctl --user start rewindos-daemon` → frames appear in DB

---

## Phase 5: Tauri UI & Search

### T5.1 — Tauri backend commands
- Implement Tauri commands in `src-tauri/src/lib.rs`:
  - `search(query, filters) → Vec<SearchResult>` (direct SQLite query via rewindos-core)
  - `get_screenshot(id) → ScreenshotDetail` (full metadata + OCR text)
  - `get_screenshot_image(path) → base64 or asset URL` (serve screenshot file)
  - `get_daemon_status() → DaemonStatus` (D-Bus call to daemon)
  - `pause_capture()` / `resume_capture()` (D-Bus calls)
- Wire commands into Tauri app builder
- Test: invoke each command from frontend console

### T5.2 — D-Bus client in Tauri
- Implement `dbus_client.rs` in src-tauri
- Connect to `com.rewindos.Daemon` on session bus
- Proxy methods: pause, resume, get_status
- Listen for `CaptureStateChanged` signal (future: update tray icon)
- Handle daemon not running gracefully (show "Daemon not running" in UI)

### T5.3 — Search UI implementation
- **SearchBar component**: text input with debounced search (300ms), app filter dropdown, date range picker
- **SearchResults component**: scrollable list of result cards showing:
  - Thumbnail (lazy-loaded)
  - Timestamp (formatted: "Today 2:34 PM" / "Jan 15, 2:34 PM")
  - App name + window title
  - Matched text snippet with highlights
  - Click → opens detail view
- **ScreenshotDetail component**: full-size screenshot view with:
  - Full OCR text panel (side by side with image)
  - Metadata (app, window title, timestamp)
  - Back button to results
- Use TanStack Query for search caching and pagination
- Responsive layout (works at 800px+ width)

### T5.4 — Global hotkey
- Register `Ctrl+Shift+Space` as global shortcut via Tauri's global shortcut plugin
- On trigger: if app is hidden → show and focus search input; if visible → focus search input
- Handle registration failure gracefully (log, show notification)
- Add to Tauri capabilities/permissions

### T5.5 — System tray (minimal)
- Add Tauri system tray with:
  - App icon
  - Menu items: "Open Search", "Pause/Resume Capture", "Quit"
- Closing window hides to tray instead of quitting
- Tray icon changes based on capture state (capturing vs. paused)

---

## Phase 6: Polish & Testing

### T6.1 — Privacy controls (config-based)
- Excluded apps list in config.toml (checked before capture)
- Excluded window title patterns (regex match)
- Auto-exclude common sensitive apps by default
- Manual delete: Tauri command to delete screenshots in a time range (with file cleanup)

### T6.2 — Error handling and resilience
- PipeWire reconnection with exponential backoff
- Tesseract process timeout (10s) and failure handling
- Disk space check before screenshot write (pause if < 1GB free)
- Database connection recovery
- Structured error types throughout (thiserror)

### T6.3 — Integration testing
- End-to-end test: start daemon → wait for captures → search → verify results
- Pipeline test with mock frames
- D-Bus interface test (start daemon, call all methods)
- Search performance benchmark (100k rows)

### T6.4 — Documentation and packaging
- README.md with install instructions
- System dependency list (pipewire, tesseract, etc.)
- Build instructions (cargo build, bun install)
- systemd service install instructions
- First-run guide (permission dialog, config)

---

## Dependency Graph

```
T0.1 → T0.2 → T0.3 (parallel with T0.4)
              → T0.4

T0.2 → T1.1 → T1.2 → T1.3
             → T1.4

T0.2 → T2.1 → T2.2 → T2.5
       T2.3 (parallel, depends on T1.2)
       T2.4 (parallel)

T2.3 → T3.1 → T3.2 → T2.5 (full pipeline)

T2.5 + T4.1 → T4.2

T1.3 + T4.1 → T5.1 → T5.2
                     → T5.3
                     → T5.4
                     → T5.5

T5.* → T6.*
```

## Critical Path

**T0.1 → T0.2 → T1.1 → T1.2 → T2.1 → T2.2 → T2.3 → T3.1 → T2.5 → T4.2 → T5.1 → T5.3**

This is the shortest path to "capture a frame and search for text in it."
Everything else can be parallelized around this.

## System Dependencies (must be installed)

```bash
# Ubuntu/Debian
sudo apt install \
  libpipewire-0.3-dev \
  tesseract-ocr \
  tesseract-ocr-eng \
  libclang-dev \
  libsqlite3-dev \
  libdbus-1-dev \
  pkg-config \
  build-essential

# Rust toolchain
rustup default stable
```
