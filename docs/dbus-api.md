# RewindOS - D-Bus API Contract

## Overview

The capture daemon exposes a D-Bus service on the **session bus** for control by the Tauri UI, CLI tools, and desktop integration.

## Service Details

| Field | Value |
|---|---|
| Bus | Session (user) |
| Bus Name | `com.rewindos.Daemon` |
| Object Path | `/com/rewindos/Daemon` |
| Interface | `com.rewindos.Daemon` |

## Introspection XML

```xml
<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
  "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="com.rewindos.Daemon">

    <!-- Pause screen capture -->
    <method name="Pause">
      <annotation name="org.freedesktop.DBus.Method.NoReply" value="false"/>
    </method>

    <!-- Resume screen capture -->
    <method name="Resume">
      <annotation name="org.freedesktop.DBus.Method.NoReply" value="false"/>
    </method>

    <!-- Get daemon status as JSON -->
    <method name="GetStatus">
      <arg name="status_json" type="s" direction="out"/>
    </method>

    <!-- Search screenshots by OCR text -->
    <method name="Search">
      <arg name="query" type="s" direction="in"/>
      <arg name="filters_json" type="s" direction="in"/>
      <arg name="results_json" type="s" direction="out"/>
    </method>

    <!-- Delete all screenshots in a time range -->
    <method name="DeleteRange">
      <arg name="start_timestamp" type="x" direction="in"/>
      <arg name="end_timestamp" type="x" direction="in"/>
      <arg name="deleted_count" type="t" direction="out"/>
    </method>

    <!-- Re-run window info provider selection and hot-swap -->
    <method name="RecheckWindowInfo">
      <arg name="provider_name" type="s" direction="out"/>
    </method>

    <!-- Toggle the privacy escape hatch (capture without exclusion enforcement) -->
    <method name="SetUnfilteredCapture">
      <arg name="enabled" type="b" direction="in"/>
    </method>

    <!-- Start recording a meeting (mic + system audio → Whisper transcription) -->
    <method name="StartMeeting">
      <arg name="title" type="s" direction="in"/>
      <arg name="meeting_id" type="x" direction="out"/>
    </method>

    <!-- Stop the active meeting and flush the transcript -->
    <method name="StopMeeting">
    </method>

    <!-- Emitted when capture state or meeting-recording state changes -->
    <signal name="StateChanged">
      <arg name="is_capturing" type="b"/>
      <arg name="meeting_active" type="b"/>
    </signal>

    <!-- Whether capture is currently active -->
    <property name="IsCapturing" type="b" access="read">
      <annotation name="org.freedesktop.DBus.Property.EmitsChangedSignal" value="true"/>
    </property>

    <!-- Capture interval in seconds -->
    <property name="CaptureInterval" type="u" access="readwrite">
      <annotation name="org.freedesktop.DBus.Property.EmitsChangedSignal" value="true"/>
    </property>

  </interface>
</node>
```

## Method Details

### Pause()

Pauses screen capture. Frames already in the pipeline will finish processing.

**Request:** (none)
**Response:** (none)
**Errors:** `com.rewindos.Error.NotRunning` — pipeline not started

### Resume()

Resumes screen capture after pause.

**Request:** (none)
**Response:** (none)
**Errors:** `com.rewindos.Error.AlreadyRunning` — already capturing

### StartMeeting(title) → i64

Starts recording a meeting: opens mic and system-audio capture streams, begins
Whisper transcription, and creates a meeting row in the database. `title` may
be an empty string (stored as untitled). Returns the new meeting id.

**Request:**
- `title` (string): Display name for the meeting. Pass `""` for untitled.

**Response:**
- `meeting_id` (i64): Row id of the newly created meeting.

**Errors:**
- `com.rewindos.Error.AlreadyRunning` — a meeting is already being recorded
- `com.rewindos.Error.ModelNotAvailable` — no Whisper GGUF model is installed
- `com.rewindos.Error.AudioCaptureFailed` — audio capture streams could not be opened

### StopMeeting()

Stops the active meeting: finalises audio files, flushes the transcript buffer,
and triggers best-effort post-processing (embedding generation and an Ollama
summary). Post-processing failures are non-fatal and logged only.

**Request:** (none)
**Response:** (none)
**Errors:** `com.rewindos.Error.NotRunning` — no meeting is currently active

### GetStatus() → String

Returns current daemon status as JSON.

**Response format:**
```json
{
  "is_capturing": true,
  "frames_captured_today": 2847,
  "frames_deduplicated_today": 1523,
  "frames_ocr_pending": 3,
  "queue_depths": {
    "capture": 0,
    "hash": 1,
    "ocr": 3,
    "index": 0
  },
  "uptime_seconds": 28847,
  "disk_usage_bytes": 1073741824,
  "last_capture_timestamp": 1706140800,
  "meeting_active": false,
  "meeting_id": null,
  "meeting_started_at": null
}
```

**Capture-integrity fields:**
- `capture_state` (string): one of `"capturing"`, `"stalled"`, `"paused_user"`,
  `"paused_privacy"`, `"paused_locked"`. The effective state (may differ from
  `is_capturing`, which reflects user intent only).
- `seconds_since_last_frame` (int|null): seconds since the last genuine frame;
  `null` if no frame has arrived yet.
- `unfiltered_capture` (bool): the privacy escape hatch is active — capture is
  running without enforcing exclusions.

**Meeting fields** (present in all daemon versions; default to `false`/`null` when
the meeting-transcription feature is not in use):
- `meeting_active` (bool): whether a meeting is currently being recorded.
- `meeting_id` (int|null): row id of the active meeting, or `null` when no
  meeting is in progress.
- `meeting_started_at` (int|null): Unix-seconds timestamp at which the active
  meeting started, or `null` when no meeting is in progress.

### Search(query, filters_json) → String

Search OCR text across all screenshots.

**Request:**
- `query` (string): FTS5 search query (supports AND, OR, NOT, phrases)
- `filters_json` (string): JSON filters object

```json
{
  "start_time": 1706054400,
  "end_time": 1706140800,
  "app_name": "firefox",
  "limit": 50,
  "offset": 0
}
```
All filter fields are optional. Defaults: limit=50, offset=0, no time/app filter.

**Response:**
```json
{
  "results": [
    {
      "id": 12345,
      "timestamp": 1706137200,
      "app_name": "firefox",
      "window_title": "Stack Overflow - How to...",
      "thumbnail_path": "screenshots/2025-01-25/thumbs/1706137200.webp",
      "file_path": "screenshots/2025-01-25/1706137200.webp",
      "matched_text": "...the <mark>PostgreSQL</mark> connection pool was...",
      "rank": -12.5,
      "group_count": 5,
      "group_screenshot_ids": [12345, 12340, 12335, 12330, 12325]
    }
  ],
  "total_count": 142,
  "search_mode": "hybrid"
}
```

**New fields (scene deduplication):**
- `group_count` (optional): Number of visually similar screenshots grouped under this result. Only present when > 1.
- `group_screenshot_ids` (optional): IDs of all screenshots in the group. Only present when grouped.
- `search_mode`: `"keyword"` (FTS5 only) or `"hybrid"` (FTS5 + vector + RRF). Always present.
```

### DeleteRange(start_timestamp, end_timestamp) → u64

Delete all screenshots and associated data in the given time range.
Also deletes WebP files from disk.

**Request:**
- `start_timestamp` (i64): Unix timestamp (inclusive)
- `end_timestamp` (i64): Unix timestamp (inclusive)

**Response:**
- `deleted_count` (u64): Number of screenshots deleted

### RecheckWindowInfo() → String

Re-runs window-info provider selection and hot-swaps the active provider
without restarting the daemon. Returns the new provider name (e.g.
`window-calls-ext`). Used after the user installs the Window Calls Extended
GNOME extension so app/window tracking activates immediately. If selection
resolves to the same provider already active, it is left running untouched and
its name is returned.

**Response:**
- `provider_name` (String): Name of the now-active window info provider

### SetUnfilteredCapture(enabled)

Toggles the privacy escape hatch. When `enabled` is true, capture proceeds even
when the active window-info provider cannot produce reliable metadata to enforce
the exclusion lists (the privacy gate would otherwise pause capture). In-memory
and per-session — re-defaults to fail-closed on daemon restart unless
`privacy.capture_without_exclusion_enforcement = true` is set in `config.toml`.
Recomputes the privacy gate immediately.

**Request:**
- `enabled` (bool)

**Response:** (none)

## Properties

### IsCapturing (bool, read-only)

Whether the capture pipeline is currently active.
Emits `PropertiesChanged` signal when toggled.

### CaptureInterval (u32, read-write)

Current capture interval in seconds. Writing updates the timer immediately.
Emits `PropertiesChanged` signal when changed.

## Signals

### StateChanged(is_capturing: bool, meeting_active: bool)

Emitted when capture is paused/resumed (Pause/Resume) or a meeting starts/stops
(StartMeeting/StopMeeting). Lets clients update the tray icon and status indicator
without polling `GetStatus`. The tray subscribes to this and shows a red square
while `meeting_active`, the live dot while capturing, and a dimmed glyph while paused.

## zbus Rust Interface

```rust
use zbus::interface;

struct DaemonService {
    // ... internal state
}

#[interface(name = "com.rewindos.Daemon")]
impl DaemonService {
    async fn pause(&mut self) -> zbus::fdo::Result<()>;
    async fn resume(&mut self) -> zbus::fdo::Result<()>;
    async fn get_status(&self) -> zbus::fdo::Result<String>;
    async fn search(&self, query: &str, filters_json: &str) -> zbus::fdo::Result<String>;
    async fn delete_range(&self, start: i64, end: i64) -> zbus::fdo::Result<u64>;
    async fn recheck_window_info(&mut self) -> zbus::fdo::Result<String>;
    async fn set_unfiltered_capture(&mut self, enabled: bool) -> zbus::fdo::Result<()>;
    async fn start_meeting(&self, title: &str) -> zbus::fdo::Result<i64>;
    async fn stop_meeting(&self) -> zbus::fdo::Result<()>;
    // Mic source selection + live level meter (used by the Meetings UI picker).
    async fn list_audio_sources(&self) -> zbus::fdo::Result<String>; // JSON [{id,name,description}]
    async fn start_mic_monitor(&self, source: &str) -> zbus::fdo::Result<()>; // "" = default
    async fn stop_mic_monitor(&self) -> zbus::fdo::Result<()>;
    async fn get_mic_level(&self) -> zbus::fdo::Result<f64>; // RMS 0.0..~1.0

    #[zbus(signal)]
    async fn state_changed(
        emitter: &SignalEmitter<'_>,
        is_capturing: bool,
        meeting_active: bool,
    ) -> zbus::Result<()>;

    #[zbus(property)]
    fn is_capturing(&self) -> bool;

    #[zbus(property)]
    fn capture_interval(&self) -> u32;

    #[zbus(property)]
    fn set_capture_interval(&mut self, interval: u32);
}
```

## Testing with busctl

```bash
# Check if daemon is running
busctl --user list | grep rewindos

# Get status
busctl --user call com.rewindos.Daemon /com/rewindos/Daemon com.rewindos.Daemon GetStatus

# Pause capture
busctl --user call com.rewindos.Daemon /com/rewindos/Daemon com.rewindos.Daemon Pause

# Resume capture
busctl --user call com.rewindos.Daemon /com/rewindos/Daemon com.rewindos.Daemon Resume

# Search
busctl --user call com.rewindos.Daemon /com/rewindos/Daemon com.rewindos.Daemon Search ss "postgresql" "{}"

# Monitor signals
busctl --user monitor com.rewindos.Daemon

# Start a meeting (titled)
busctl --user call com.rewindos.Daemon /com/rewindos/Daemon com.rewindos.Daemon StartMeeting s "Weekly sync"

# Start a meeting (untitled)
busctl --user call com.rewindos.Daemon /com/rewindos/Daemon com.rewindos.Daemon StartMeeting s ""

# Stop the active meeting
busctl --user call com.rewindos.Daemon /com/rewindos/Daemon com.rewindos.Daemon StopMeeting
```
