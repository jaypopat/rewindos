# RewindOS — Meeting Transcription (Phase 1) Design

**Date:** 2026-06-05
**Status:** Draft for review (revised against codebase)
**Author:** brainstormed with Claude, corrected against the tree

## Summary

Add explicit-opt-in meeting capture to RewindOS: the user starts a recording, the
daemon captures **mic** and **system output** audio as two separate PipeWire
streams, transcribes them locally with **whisper.cpp**, stores timestamped,
source-labeled transcript segments (indexed for full-text + semantic search via a
new transcript-specific path), keeps the audio, and produces a post-meeting
summary via the existing Ollama client. Transcript timestamps align to the
screenshot timeline.

> **Framing correction (important).** The original draft framed this as "reuses
> the existing pipeline shape rather than introducing new infrastructure." That is
> true *conceptually* but misleading at the code level. What actually reuses
> cleanly: the `pipewire` crate dependency, the Ollama embedding **model**
> (nomic-embed-text, 768-dim), the Ollama chat client, refinery migrations, the
> retention-sweep pattern, and the D-Bus service shape. What is **net-new**: audio
> capture (the existing PipeWire path is hardcoded to video), Opus encoding, the
> whisper sidecar, the transcript FTS + vector tables, **search code that unions
> screenshots with transcripts**, and a frontend Meetings view. Estimate and
> sequence accordingly — this is a parallel capture+transcribe pipeline that
> *shares plumbing*, not a thin extension of the screenshot pipeline.

## Goals

- Explicit start/stop meeting capture (hotkey + tray + D-Bus).
- Capture mic (You) and system output (Remote) as separate streams.
- Local transcription via whisper.cpp — no cloud, no Python/torch deps.
- Timestamped, source-labeled (`You`/`Remote`) transcript segments.
- Searchable via a transcript FTS + semantic path; aligned to the screenshot timeline.
- Keep audio (Opus), with a config toggle.
- Post-meeting summary + action items via existing Ollama.
- A Meetings UI surface to browse, read transcripts, play audio, and see summaries.

## Non-Goals (deferred to Phase 2)

- True multi-speaker diarization on the Remote side (pyannote-style). Phase 1
  gets You-vs-Remote labeling from source separation; per-person remote
  diarization is a separate spec.
- Real-time low-latency captions. Phase 1 transcribes in ~30s windows.
- Cross-device/Bluetooth hot-swap mid-meeting (snapshot devices at start).
- Per-application audio isolation (see "Known limitations").

## Why desktop compatibility is NOT the hard part

The GNOME/KDE fragmentation that affects screen capture (window-info providers,
`xdg-desktop-portal` screencast) does **not** apply to audio. Audio on all modern
Linux desktops is **PipeWire** — the same stack RewindOS already links against for
video. Capturing the default sink's monitor and the mic source is uniform across
DEs and needs no per-desktop provider. This subsystem is DE-agnostic.

**Caveat:** "uniform" refers to the DE layer. The audio *capture code itself* does
not exist yet — see Architecture.

## What the existing code actually provides (verified)

| Assumption in original draft | Reality in tree | Consequence |
|---|---|---|
| PipeWire "already used for video frames" | `pipewire = "0.9"` in `crates/rewindos-daemon/Cargo.toml`; capture is `xdg-desktop-portal → PipeWire screencast`; SPA format negotiation in `capture/portal.rs` is **hardcoded to `SPA_MEDIA_TYPE_video` / `SPA_VIDEO_FORMAT_*`** | Audio capture is **from scratch**: direct node connection to sink-monitor + mic source, audio SPA format negotiation, ring buffers. No portal involved. |
| OCR runs as "sidecars" with lazy spawn + idle reaper | **Tesseract (default)** is a per-image subprocess: `spawn → wait_with_output → exit` (`ocr.rs:80`). Only **PaddleOCR (optional)** is a true idle-reaper sidecar (`paddle_ocr.rs`). | Model whisper.cpp on the **per-window subprocess** pattern (spawn whisper on a WAV, read segments, exit). An idle-reaper is unnecessary complexity for Phase 1. |
| Pipeline is "4 tokio tasks (capture → hash → ocr → index)" | Actually **5 tasks**: capture → hash → ocr → index → **embed** (`pipeline.rs:42`). CLAUDE.md is stale. | Minor, but the embed stage is the pattern to copy for transcript embeddings. |
| OCR text "queued for embeddings, search works with no new code" | FTS (`ocr_fts`), vec table (`ocr_embeddings`), `EmbedRequest`, and `hybrid_search` RRF are **all keyed on `screenshot_id`** (`db.rs:381,1088,1165`; `schema.rs:247`). | Transcript search needs **new tables and new search code** that unions screenshots + segments. The embedding *model/Ollama client* reuses; the *indexing/search plumbing* does not. |
| Schema version 8, refinery | Confirmed — highest is `V008__chat_model.sql`. Next is **V009**. | — |
| Retention sweep exists | `delete_screenshots_before(timestamp)` / `delete_screenshots_in_range` (`db.rs:668,692`) collect file paths, delete FTS rows, delete table rows, `remove_files`. | Add a parallel `delete_meetings_before(timestamp)` following the same shape; the daemon retention loop calls both. |
| D-Bus `Pause`/`Resume`/`GetStatus` to mirror | Confirmed on `com.rewindos.Daemon` (`service.rs:46`). | Add `StartMeeting`/`StopMeeting` methods alongside; extend `DaemonStatus`. |

## Architecture

A **parallel** pipeline, separate from the always-on screenshot pipeline, gated by
explicit start/stop:

```
StartMeeting (D-Bus/hotkey/tray)
        │
        ▼
 Audio capture stage        ── 2 PipeWire input streams: mic + sink-monitor
        │  (capture/audio.rs)   → ring buffers, ~30s windows per source (VAD-trimmed)
        ▼
 Encode stage               ── Opus files appended: meetings/<id>/{mic,system}.opus
        │  (meeting/encode.rs)
        ▼
 Transcribe stage           ── whisper.cpp per-window subprocess (NOT a long sidecar)
        │  (meeting/whisper.rs) → segments {start_ms,end_ms,source,text}
        ▼
 Index stage                ── insert transcript_segments + transcript_fts +
        │  (db.rs)              transcript_embeddings (new tables, new search path)
        ▼
StopMeeting → Post-process  ── finalize Opus, drain transcription, Ollama summary
   (meeting/postprocess.rs)    → meetings.summary
```

## Components

### 1. Audio capture (`crates/rewindos-daemon/src/capture/audio.rs`) — NET-NEW
- On start, snapshot the default **sink monitor** node and default **source**
  (mic) node from PipeWire. Open two capture streams with audio SPA format
  negotiation (target: S16/F32, 16 kHz mono — whisper's native input rate, so
  resample at capture).
- Buffer PCM per source. Emit windows on **VAD boundaries** with a ~30s cap and a
  tail flush on stop — NOT naive fixed 30s cuts (those clip words mid-sentence and
  degrade transcription). A simple energy-gate VAD is sufficient for Phase 1.
- Device changes mid-meeting: log and continue on the original nodes.
- **Spike required first:** confirm the `pipewire` 0.9 API surface for capturing a
  monitor source (the existing code only does screencast video). Write a throwaway
  binary that opens the default sink monitor and dumps PCM before committing to the
  stage design.

### 2. Encode (`crates/rewindos-daemon/src/meeting/encode.rs`) — NET-NEW
- Encode PCM windows to Opus, appending to `{mic,system}.opus` under
  `<base_dir>/meetings/<id>/`. New dependency: `audiopus` (or `opus`) + an Ogg
  container writer.
- Audio retained iff `[meeting].keep_audio` (default true). If false, encode is
  skipped and only transcripts are kept (PCM still flows to the transcribe stage).

### 3. Transcribe (`crates/rewindos-core/src/meeting/whisper.rs`) — NET-NEW
- **REVISED: use the `whisper-rs` crate (linked library), NOT a CLI subprocess.**
  `whisper-rs` vendors whisper.cpp and compiles it during `cargo build` (needs the
  C/C++ toolchain already in the system deps), so there is **no separate binary to
  ship, detect on PATH, or build by hand** — the tesseract-style "is it installed?"
  problem disappears. Transcription is an in-process FFI call, not a per-window
  subprocess. (The original subprocess design is kept here only as the fallback if
  we ever want process isolation.) Rationale: unlike audio capture — where no
  library cleanly abstracts sink-monitor capture, so native PipeWire was required —
  here the library abstracts exactly the painful part (distribution) with no cost
  to the feature.
- Input is the captured PCM window converted to **f32 mono 16 kHz** (the spike
  confirmed PipeWire negotiates S16_LE at 16 kHz mono, so the only conversion the
  capture/transcribe boundary needs is `i16 → f32` (`/32768`); no resampling).
- Model file at `<base_dir>/models/whisper/<model>.bin` (GGUF, e.g.
  `ggml-base.en.bin`/`ggml-small.en.bin`).
- Output: segments with relative offsets, shifted to absolute meeting time
  (`window_start_ms + segment.offset_ms`) and tagged with the source's speaker
  label (`mic → You`, `system → Remote`).
- **Availability check at start** (model file present; the library itself is
  compiled in, so only the model can be missing). If missing, surface an
  actionable error and refuse to start the meeting — no per-window silent-fail
  loop (lesson from the OCR-failure bug).

### 4. Storage / data model — NET-NEW tables (migration `V009`)

```sql
-- V009__meetings.sql
CREATE TABLE meetings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at        INTEGER NOT NULL,      -- unix seconds
    ended_at          INTEGER,               -- null while recording
    title             TEXT,
    app_name          TEXT,                  -- focused app at start, if available
    mic_audio_path    TEXT,
    system_audio_path TEXT,
    summary           TEXT,                  -- filled post-meeting
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE transcript_segments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id    INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    start_ms      INTEGER NOT NULL,          -- absolute, ms since epoch
    end_ms        INTEGER NOT NULL,
    source        TEXT NOT NULL,             -- 'mic' | 'system'
    speaker_label TEXT NOT NULL,             -- 'You' | 'Remote' (Phase 1)
    text          TEXT NOT NULL,
    embedding_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX idx_segments_meeting ON transcript_segments(meeting_id);
CREATE INDEX idx_segments_time ON transcript_segments(start_ms);

-- Transcript FTS (parallel to ocr_fts, keyed on segment_id)
CREATE VIRTUAL TABLE transcript_fts USING fts5(
    text,
    segment_id UNINDEXED
);

-- Transcript embeddings (parallel to ocr_embeddings, keyed on segment_id)
CREATE VIRTUAL TABLE transcript_embeddings USING vec0(
    segment_id INTEGER PRIMARY KEY,
    embedding  float[768]
);
```

- **Note the FTS coupling reality:** `ocr_fts`/`ocr_embeddings` are screenshot-keyed
  and cannot be reused directly. These parallel tables are keyed on `segment_id`.
  `ON DELETE CASCADE` covers `transcript_segments`, but **FTS5/vec0 are standalone
  tables with no cascade** — deletes must explicitly remove `transcript_fts` and
  `transcript_embeddings` rows (same gotcha `delete_screenshots_before` already
  handles for `ocr_fts`).
- Timeline alignment: `transcript_segments.start_ms` joins to
  `screenshots.timestamp_ms` by time range → "what was on screen when this was
  said," and vice-versa.

### 5. Search integration — NET-NEW code
- `insert_transcript_segment(meeting_id, seg) -> segment_id`: transaction inserting
  `transcript_segments` + `transcript_fts` (mirror of `insert_ocr_text`).
- `insert_transcript_embedding(segment_id, &[f32])`: blob encode + insert into
  `transcript_embeddings` + mark segment `embedding_status='done'` (mirror of
  `insert_embedding`).
- `search_transcripts(filters, query_embedding) -> Vec<SearchResult>`: FTS + KNN +
  RRF over the transcript tables (clone the `hybrid_search` RRF math).
- **Unified search decision (needs a product call):** either (a) extend the
  existing `search`/`hybrid_search` D-Bus path to union screenshot + transcript
  results into one ranked list, or (b) keep meeting search separate, surfaced only
  in the Meetings view. Recommendation: **(b) for Phase 1** — lower risk, avoids
  re-ranking heterogeneous result types, and meetings are a distinct user intent.
  Revisit unification in Phase 2.

### 6. Control surface (`crates/rewindos-daemon/src/service.rs`)
- D-Bus methods on `com.rewindos.Daemon`, alongside `Pause`/`Resume`:
  - `StartMeeting(title: s) -> meeting_id: x`
  - `StopMeeting() -> ()`
- A `MeetingController` (Arc, held by `DaemonService`) owns the active streams and
  the meeting id; `StartMeeting` errors if one is already active, `StopMeeting`
  errors if none is.
- Config global hotkey (like `ui.global_hotkey`) and a tray menu item.
- `DaemonStatus` extended with `meeting_active: bool`, `meeting_id: Option<i64>`,
  `meeting_started_at: Option<i64>` (all `#[serde(default)]` for back-compat).
- **Visible recording indicator** while active (tray icon state) — consent.

### 7. Tauri + Frontend — NET-NEW (missing from original draft)
- Tauri commands (`src-tauri/`): `start_meeting`, `stop_meeting`, `list_meetings`,
  `get_meeting(id)` (segments + summary), `get_meeting_audio_path(id, source)`,
  `delete_meeting(id)`, `search_transcripts(query)`.
- **Meetings view** (`src/features/meetings/`): list of past meetings, a transcript
  reader (You/Remote bubbles aligned to time, click-to-jump to the screenshot at
  that timestamp), an audio player, the AI summary + action items, and a
  recording-active banner. Mirror the structure of an existing feature folder
  (e.g. `src/features/ask/`).

### 8. Post-processing (`crates/rewindos-daemon/src/meeting/postprocess.rs`)
- On `StopMeeting`: stop streams, flush/finalize Opus, drain the transcription
  queue, then call the **existing Ollama chat client** to produce summary + action
  items → `meetings.summary`. Skipped if Ollama unreachable (logged; transcript
  still complete), matching existing behavior.

### 9. Config (`[meeting]` in config.toml + `MeetingConfig` in `rewindos-core`)
```toml
[meeting]
enabled = true
engine = "whisper-cpp"
model = "base.en"            # base.en | small.en | ...
model_dir = "~/.rewindos/models/whisper"
whisper_bin = "whisper-cli"  # path or PATH name of the whisper.cpp binary
keep_audio = true
summary_enabled = true
hotkey = "Ctrl+Shift+M"
sample_rate = 16000
```
- Add `MeetingConfig` to `AppConfig` with `#[serde(default)]` and a `Default` impl,
  following the `FocusConfig`/`ChatConfig` pattern in `config.rs`.
- `AppConfig` gains `meetings_dir()` and `whisper_model_dir()` helpers; `ensure_dirs`
  creates `meetings/` and `models/whisper/`.

## Distribution (missing from original draft)

- **whisper engine:** use the **`whisper-rs` crate** (vendors + compiles whisper.cpp
  during `cargo build`). No separate binary to ship, build, or detect on PATH — it
  links in like any other Rust dep. Requires the C/C++ toolchain (already a system
  dep) at build time; optional GPU via cargo features (`cuda`/`vulkan`). There is
  **no apt package** for the whisper.cpp CLI on Ubuntu/TUXEDO, which is the other
  reason to vendor rather than depend on a system binary.
- **Whisper model download:** `base.en` is ~140 MB (GGUF). This is the only piece
  NOT covered by `cargo build` — provide a "Download model" action in Settings that
  fetches the GGUF to `model_dir`, mirroring how Ollama models are pulled
  (`embedding.rs` `pull_model`). Do not bundle the model in the app image.
- **Opus encoding dep:** add `audiopus`/`opus` + `ogg` to `rewindos-daemon`
  (`libopus-dev` exists as a system package, but the `audiopus` crate can build
  vendored, keeping the no-system-binary property consistent with whisper-rs).

## Privacy & consent

- **Explicit start only** — never auto-records. No mic-activity or app-focus triggers.
- Visible recording indicator whenever a meeting is active (tray + in-app banner).
- Local-only storage; nothing leaves the machine (Ollama is local).
- `keep_audio` toggle; deleting a meeting cascades to segments and explicitly
  removes `transcript_fts`/`transcript_embeddings` rows + audio files.
- Two-party-consent jurisdictions: the active-recording state must be unmistakable.
  A one-time consent acknowledgment on first use is recommended.

## Known limitations (state these plainly to users)

- **Speakers vs. headphones:** without headphones, the mic captures the remote
  voice (acoustic bleed), polluting the "You" label. Clean separation assumes
  headphones.
- **System monitor is system-wide:** the "Remote" stream captures *all* system
  audio — notifications, music, other apps — not just the meeting app. No per-app
  isolation in Phase 1.
- **Transcription quality on system audio** (compressed VoIP, overlapping remote
  speakers, music) is materially worse than on a clean mic; summary quality follows.

## Error handling

- whisper binary/model missing → actionable startup error; **refuse to start** the
  meeting rather than silent-fail per window.
- PipeWire stream death during a meeting → attempt rebuild (reuse the
  `needs_reconnect`-style pattern from video capture); on hard failure, finalize
  what was captured and mark the meeting ended with a warning.
- Ollama unreachable at summary time → transcript saved, summary left null, logged.
- Disk pressure with `keep_audio` → covered by extending the retention sweep to
  `meetings/` (`delete_meetings_before`).

## Testing

- **Unit (`rewindos-core`):** segment time-shifting (relative→absolute),
  source→label mapping, `MeetingConfig` parse/defaults, whisper JSON parsing,
  delete-purges-fts+vec.
- **Migration:** `V009` applies on a fresh DB and on a V008 DB.
- **Transcribe:** golden short WAV → expected transcript (fuzzy match); missing
  binary/model error path.
- **DB integration:** insert meeting + segments → FTS hit, vector hit, RRF order;
  `delete_meeting` purges segments + fts + embeddings + files.
- **Daemon integration:** Start → feed synthetic PCM → Stop → assert meeting row,
  segments with correct labels/timestamps, audio file present iff keep_audio.
  (Run daemon tests with `--test-threads=1`.)
- **Privacy:** deleting a meeting purges everything; status reflects active state.

## Pre-implementation checks

- **Spike `capture/audio.rs` first** — confirm `pipewire` 0.9 can capture a sink
  monitor source. This is the single biggest unknown; do it before anything else.
- Confirm the Opus encoding crate choice builds against `ubuntu-24.04`
  (release-runner constraint).
- Confirm whisper.cpp JSON output format for the pinned binary version.
- Migration numbering: next is **V009**.

## Phase 2 (out of scope here)

- pyannote-style diarization to split the Remote stream into individual speakers.
- Near-real-time captions.
- Unified screenshot+transcript search ranking.
- Optional, consent-gated meeting auto-detection on top of explicit control.
