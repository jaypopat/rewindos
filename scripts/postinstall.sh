#!/bin/bash
# Post-install script for RewindOS .deb/.rpm package
# Copies daemon binary and installs systemd user service

INSTALL_DIR="/usr/lib/rewindos"
SYSTEMD_DIR="/usr/lib/systemd/user"

# Find the daemon binary and service file wherever they landed
# DEB puts resources in /usr/share/rewindos/
# RPM puts resources in /usr/lib/RewindOS/ (with relative paths preserved)
DAEMON_BIN=$(find /usr/share/rewindos /usr/lib/RewindOS /usr/lib/rewindos /usr/share/RewindOS -name "rewindos-daemon" ! -name "*.service" -type f 2>/dev/null | head -1)
SERVICE_FILE=$(find /usr/share/rewindos /usr/lib/RewindOS /usr/lib/rewindos /usr/share/RewindOS -name "rewindos-daemon.service" -type f 2>/dev/null | head -1)

if [ -z "$DAEMON_BIN" ]; then
    echo "RewindOS: daemon binary not found, skipping service setup" >&2
    exit 0
fi

# Copy daemon binary to a stable location
mkdir -p "$INSTALL_DIR"
cp "$DAEMON_BIN" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/rewindos-daemon"

# Install systemd user service with correct binary path
mkdir -p "$SYSTEMD_DIR"
if [ -n "$SERVICE_FILE" ]; then
    sed "s|%h/.local/bin/rewindos-daemon|/usr/lib/rewindos/rewindos-daemon|" \
        "$SERVICE_FILE" > "$SYSTEMD_DIR/rewindos-daemon.service"
fi

# Enable the daemon for all users (takes effect on next login)
systemctl --global enable rewindos-daemon.service 2>/dev/null || true
