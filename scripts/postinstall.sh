#!/bin/bash
# Post-install script for RewindOS .deb/.rpm package
# Copies daemon binary and installs systemd user service

INSTALL_DIR="/usr/lib/rewindos"
SYSTEMD_DIR="/usr/lib/systemd/user"

# Resources land in different places depending on package format:
#   DEB: /usr/share/rewindos/
#   RPM: /usr/lib/RewindOS/up/  (Tauri preserves "../" as "up/")
if [ -f "/usr/share/rewindos/rewindos-daemon" ]; then
    DAEMON_BIN="/usr/share/rewindos/rewindos-daemon"
    SERVICE_FILE="/usr/share/rewindos/rewindos-daemon.service"
elif [ -f "/usr/lib/RewindOS/up/target/release/rewindos-daemon" ]; then
    DAEMON_BIN="/usr/lib/RewindOS/up/target/release/rewindos-daemon"
    SERVICE_FILE="/usr/lib/RewindOS/up/systemd/rewindos-daemon.service"
else
    echo "RewindOS: daemon binary not found, skipping service setup" >&2
    exit 0
fi

# Copy daemon binary to a stable location
mkdir -p "$INSTALL_DIR"
cp "$DAEMON_BIN" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/rewindos-daemon"

# Install systemd user service with correct binary path
mkdir -p "$SYSTEMD_DIR"
if [ -f "$SERVICE_FILE" ]; then
    sed "s|%h/.local/bin/rewindos-daemon|/usr/lib/rewindos/rewindos-daemon|" \
        "$SERVICE_FILE" > "$SYSTEMD_DIR/rewindos-daemon.service"
fi

# Enable the daemon for all users (takes effect on next login)
systemctl --global enable rewindos-daemon.service 2>/dev/null || true
