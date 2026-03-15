#!/usr/bin/env bash
# Install RewindOS daemon on a test VM.
# Detects distro, installs runtime deps, copies binary + systemd service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_BIN="$SCRIPT_DIR/rewindos-daemon"

if [ ! -f "$DAEMON_BIN" ]; then
    echo "ERROR: rewindos-daemon binary not found in $SCRIPT_DIR"
    exit 1
fi

echo "==> Detecting package manager..."

install_deps() {
    if command -v apt-get &>/dev/null; then
        echo "==> Debian/Ubuntu detected, installing deps with apt..."
        sudo apt-get update -qq
        sudo apt-get install -y tesseract-ocr tesseract-ocr-eng libpipewire-0.3-0 libdbus-1-3
    elif command -v dnf &>/dev/null; then
        echo "==> Fedora/RHEL detected, installing deps with dnf..."
        sudo dnf install -y tesseract tesseract-langpack-eng pipewire-libs dbus-libs
    elif command -v pacman &>/dev/null; then
        echo "==> Arch-based detected, installing deps with pacman..."
        sudo pacman -S --noconfirm --needed tesseract tesseract-data-eng pipewire dbus
    elif command -v zypper &>/dev/null; then
        echo "==> openSUSE detected, installing deps with zypper..."
        sudo zypper install -y tesseract-ocr tesseract-ocr-traineddata-english pipewire dbus-1
    else
        echo "WARNING: Unknown package manager. Install manually:"
        echo "  - tesseract-ocr + English language data"
        echo "  - PipeWire libraries"
        echo "  - D-Bus libraries"
    fi
}

install_deps

echo "==> Installing daemon binary to ~/.local/bin/"
mkdir -p ~/.local/bin
cp "$DAEMON_BIN" ~/.local/bin/rewindos-daemon
chmod +x ~/.local/bin/rewindos-daemon

echo "==> Installing systemd user service..."
mkdir -p ~/.config/systemd/user
cp "$SCRIPT_DIR/rewindos-daemon.service" ~/.config/systemd/user/
systemctl --user daemon-reload

echo ""
echo "==> Installation complete!"
echo "    Binary: ~/.local/bin/rewindos-daemon"
echo "    Service: ~/.config/systemd/user/rewindos-daemon.service"
echo ""
echo "    To start: systemctl --user start rewindos-daemon"
echo "    To test:  ./test.sh"
