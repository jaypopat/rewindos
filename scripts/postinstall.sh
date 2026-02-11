#!/bin/bash
# Post-install script for RewindOS .deb/.rpm package
# Copies daemon binary and installs systemd user service

INSTALL_DIR="/usr/lib/rewindos"
SYSTEMD_DIR="/usr/lib/systemd/user"
RESOURCE_DIR="/usr/share/rewindos"

# Copy daemon binary to a stable location
mkdir -p "$INSTALL_DIR"
if [ -f "$RESOURCE_DIR/rewindos-daemon" ]; then
    cp "$RESOURCE_DIR/rewindos-daemon" "$INSTALL_DIR/"
    chmod +x "$INSTALL_DIR/rewindos-daemon"
fi

# Install systemd user service with correct binary path
mkdir -p "$SYSTEMD_DIR"
if [ -f "$RESOURCE_DIR/rewindos-daemon.service" ]; then
    sed "s|%h/.local/bin/rewindos-daemon|/usr/lib/rewindos/rewindos-daemon|" \
        "$RESOURCE_DIR/rewindos-daemon.service" > "$SYSTEMD_DIR/rewindos-daemon.service"
fi

systemctl --global daemon-reload || true
