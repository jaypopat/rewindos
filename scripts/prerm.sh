#!/bin/bash
# Pre-remove script for RewindOS .deb/.rpm package
# Disables the systemd user service before uninstall

systemctl --global disable rewindos-daemon.service 2>/dev/null || true
rm -f /usr/lib/systemd/user/rewindos-daemon.service
systemctl --global daemon-reload || true
