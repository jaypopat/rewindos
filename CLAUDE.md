# RewindOS - Development Context

## What is this?
Privacy-first, local-only screen capture and search tool for Linux/Wayland.
MVP: capture → OCR → full-text search.

## Architecture Decisions (locked in)
- **Capture**: xdg-desktop-portal → PipeWire stream (zbus + pipewire-rs)
- **OCR**: Tesseract CLI subprocess (upgrade to PaddleOCR post-MVP)
- **Storage**: WebP screenshots only (no video for MVP)
- **Database**: SQLite + FTS5 (rusqlite, bundled)
- **Migrations**: refinery with embedded SQL
- **Pipeline**: 4 tokio tasks connected by bounded mpsc channels (capture → hash → ocr → index)
- **Daemon**: Separate systemd user service (rewindos-daemon)
- **IPC**: D-Bus session bus (zbus) — com.rewindos.Daemon
- **Hashing**: image-hasher crate (gradient hash, 8x8)
- **Window info**: wlr-foreign-toplevel → KWin D-Bus → X11 fallback
- **Frontend**: React 19 + shadcn/ui + Tailwind CSS + TanStack Query
- **Global hotkey**: Ctrl+Shift+Space
- **Package manager**: Bun

## Project Layout (Cargo workspace)
- `crates/rewindos-core/` — shared lib (DB, OCR, hashing, config, types)
- `crates/rewindos-daemon/` — capture daemon (PipeWire, pipeline, D-Bus server)
- `src-tauri/` — Tauri UI app (search commands, D-Bus client)
- `src/` — React frontend

## Key Documentation
- `docs/architecture.md` — Full system architecture
- `docs/database-schema.md` — SQLite schema + queries
- `docs/mvp-tasks.md` — Actionable task breakdown (T0.1 through T6.4)
- `docs/dbus-api.md` — D-Bus interface contract
- `docs/capture-pipeline.md` — Pipeline deep dive with data types
- `docs/frontend-spec.md` — UI layout, components, Tauri IPC

## Target Platform
KDE Plasma 6+ on Ubuntu 24.04+ (Wayland)

## System Dependencies
```bash
sudo apt install libpipewire-0.3-dev tesseract-ocr tesseract-ocr-eng libclang-dev libdbus-1-dev pkg-config build-essential
```

## Build Commands
```bash
cargo build --workspace          # Build all Rust crates
bun install                      # Install frontend deps
bun run tauri dev                # Run Tauri app in dev mode
cargo run -p rewindos-daemon     # Run capture daemon directly
```
