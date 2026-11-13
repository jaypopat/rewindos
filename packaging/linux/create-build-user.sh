#!/usr/bin/env bash
# D-Bus needs a passwd entry, not just a numeric container UID.
set -euo pipefail
uid=$1
gid=$2
if ! getent group "$gid" >/dev/null; then
  groupadd --gid "$gid" rewindos-build
fi
if ! getent passwd "$uid" >/dev/null; then
  useradd --uid "$uid" --gid "$gid" --no-create-home \
    --home-dir /work/.build-home --shell /bin/bash rewindos-build
fi
