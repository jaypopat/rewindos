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

    <!-- Emitted when capture state changes -->
    <signal name="CaptureStateChanged">
      <arg name="is_capturing" type="b"/>
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
  "last_capture_timestamp": 1706140800
}
```

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
      "rank": -12.5
    }
  ],
  "total_count": 142
}
```

### DeleteRange(start_timestamp, end_timestamp) → u64

Delete all screenshots and associated data in the given time range.
Also deletes WebP files from disk.

**Request:**
- `start_timestamp` (i64): Unix timestamp (inclusive)
- `end_timestamp` (i64): Unix timestamp (inclusive)

**Response:**
- `deleted_count` (u64): Number of screenshots deleted

## Properties

### IsCapturing (bool, read-only)

Whether the capture pipeline is currently active.
Emits `PropertiesChanged` signal when toggled.

### CaptureInterval (u32, read-write)

Current capture interval in seconds. Writing updates the timer immediately.
Emits `PropertiesChanged` signal when changed.

## Signals

### CaptureStateChanged(is_capturing: bool)

Emitted when capture is paused or resumed. UI should update tray icon and status indicator.

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

    #[zbus(signal)]
    async fn capture_state_changed(ctxt: &SignalEmitter<'_>, is_capturing: bool) -> zbus::Result<()>;

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
```
