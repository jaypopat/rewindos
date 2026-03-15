#!/usr/bin/env bash
# Smoke test for RewindOS daemon on a test VM.
# Runs the daemon for 15 seconds with debug logging, then checks log output.
set -euo pipefail

DAEMON="${HOME}/.local/bin/rewindos-daemon"
if [ ! -f "$DAEMON" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    DAEMON="$SCRIPT_DIR/rewindos-daemon"
fi

if [ ! -f "$DAEMON" ]; then
    echo "ERROR: rewindos-daemon not found. Run install.sh first."
    exit 1
fi

DURATION="${1:-15}"
LOG_FILE="/tmp/rewindos-test-$(date +%s).log"

echo "==> Environment"
echo "    XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-<unset>}"
echo "    XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-<unset>}"
echo "    WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-<unset>}"
echo "    DISPLAY=${DISPLAY:-<unset>}"
echo "    HYPRLAND_INSTANCE_SIGNATURE=${HYPRLAND_INSTANCE_SIGNATURE:-<unset>}"
echo "    SWAYSOCK=${SWAYSOCK:-<unset>}"
echo "    COSMIC_SESSION_ID=${COSMIC_SESSION_ID:-<unset>}"
echo ""
echo "==> Running daemon for ${DURATION}s (logging to $LOG_FILE)..."

# Run daemon in background, capture all output
RUST_LOG=debug "$DAEMON" > "$LOG_FILE" 2>&1 &
DAEMON_PID=$!

# Wait, then gracefully stop
sleep "$DURATION"
kill -TERM "$DAEMON_PID" 2>/dev/null || true
wait "$DAEMON_PID" 2>/dev/null || true

echo ""
echo "==> Test Results"
echo "    -------------------------------------------------------"

PASS=0
FAIL=0

check() {
    local label="$1"
    local pattern="$2"
    if grep -qE "$pattern" "$LOG_FILE"; then
        echo "    PASS  $label"
        PASS=$((PASS + 1))
    else
        echo "    FAIL  $label"
        FAIL=$((FAIL + 1))
    fi
}

check_not() {
    local label="$1"
    local pattern="$2"
    if grep -qE "$pattern" "$LOG_FILE"; then
        echo "    FAIL  $label"
        FAIL=$((FAIL + 1))
    else
        echo "    PASS  $label"
        PASS=$((PASS + 1))
    fi
}

# Core checks
check "Desktop environment detected"  "detected environment"
check "Capture backend selected"       "using (KWin ScreenShot2|xdg-desktop-portal)"
check "Window info provider selected"  "using (KWin|wlr-foreign-toplevel|gnome-shell-dbus|noop) window info"
check "Capture pipeline started"       "capture pipeline started"
check "D-Bus service registered"       "D-Bus service registered"
check "Clean shutdown"                 "shutting down"

# Capture working (frame captured or hash computed)
check "Frames being captured"          "(KWin screenshot metadata|PipeWire stream format negotiated|frame captured|hash stage)"

# Window info not noop (warning, not failure)
if grep -qE "using noop" "$LOG_FILE"; then
    echo "    WARN  Window info is noop (no active window tracking)"
else
    echo "    PASS  Window info provider is active"
    PASS=$((PASS + 1))
fi

# Check for panics or crashes
check_not "No panics"  "panicked at|SIGSEGV|SIGABRT"

echo "    -------------------------------------------------------"
echo "    $PASS passed, $FAIL failed"
echo ""

if [ "$FAIL" -gt 0 ]; then
    echo "==> Relevant log lines:"
    grep -E "(ERROR|WARN|detected|using|capture|window info|pipeline|shutdown|panic)" "$LOG_FILE" | head -30
    echo ""
    echo "    Full log: $LOG_FILE"
    exit 1
else
    echo "    Full log: $LOG_FILE"
fi
