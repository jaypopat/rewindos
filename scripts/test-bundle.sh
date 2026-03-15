#!/usr/bin/env bash
# Build a self-contained test bundle for cross-DE testing on VMs.
# Produces: rewindos-test-bundle.tar.gz
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Building rewindos-daemon (release)..."
cargo build -p rewindos-daemon --release

BUNDLE_DIR=$(mktemp -d)
DEST="$BUNDLE_DIR/rewindos-test"
mkdir -p "$DEST"

echo "==> Assembling test bundle..."
cp target/release/rewindos-daemon "$DEST/"
cp systemd/rewindos-daemon.service "$DEST/"
cp scripts/vm-install.sh "$DEST/install.sh"
cp scripts/vm-test.sh "$DEST/test.sh"
chmod +x "$DEST/install.sh" "$DEST/test.sh" "$DEST/rewindos-daemon"

OUTPUT="$REPO_ROOT/rewindos-test-bundle.tar.gz"
tar czf "$OUTPUT" -C "$BUNDLE_DIR" rewindos-test

rm -rf "$BUNDLE_DIR"

SIZE=$(du -h "$OUTPUT" | cut -f1)
echo ""
echo "==> Bundle created: $OUTPUT ($SIZE)"
echo "    Copy to VM and run:"
echo "      tar xzf rewindos-test-bundle.tar.gz"
echo "      cd rewindos-test"
echo "      ./install.sh    # install deps + binary"
echo "      ./test.sh       # 15s smoke test"
