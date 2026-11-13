#!/usr/bin/env bash
# Native Linux build; run inside packaging/linux/Containerfile.
set -euo pipefail
cd "$(dirname "$0")/.."
arch=$(uname -m)
case "$arch" in aarch64|x86_64) ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}
# Do not bake the CI runner's CPU extensions into Whisper's C++ backend.
export GGML_NATIVE=OFF
# GNU ld's ARM64 default supports 64 KiB pages; make the ABI requirement explicit.
export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,-z,max-page-size=65536"
bun install --frozen-lockfile
bun run test
# Build daemon separately with --locked; Tauri's hook rebuilds the same target.
cargo build --locked --release -p rewindos-daemon
bun run tauri build --no-bundle -- --locked
cargo test --locked --release --workspace
stage="rewindos-linux-$arch"
mkdir -p "dist/$stage/icons"
cp target/release/rewindos target/release/rewindos-daemon "dist/$stage/"
cp systemd/rewindos-daemon.service systemd/rewindos.desktop systemd/com.rewindos.Daemon.desktop "dist/$stage/"
cp scripts/paddleocr_worker.py LICENSE "dist/$stage/"
cp src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.png} "dist/$stage/icons/"
{
  printf 'source_commit=%s\n' "$(git rev-parse HEAD)"
  rustc --version
  bun --version
  uname -m
  getconf PAGESIZE
} > "dist/$stage/BUILD-INFO.txt"
file "dist/$stage/rewindos" "dist/$stage/rewindos-daemon"
if [[ "$arch" == aarch64 ]]; then
  python3 scripts/check-asahi-elf.py "dist/$stage/rewindos" "dist/$stage/rewindos-daemon"
fi
./target/release/rewindos-daemon --version
./target/release/rewindos-daemon --help
for binary in rewindos rewindos-daemon; do
  ldd "dist/$stage/$binary" > "dist/$stage/$binary.ldd.txt"
  if grep -q 'not found' "dist/$stage/$binary.ldd.txt"; then cat "dist/$stage/$binary.ldd.txt"; exit 1; fi
done
tar -C dist -czf "dist/$stage.tar.gz" "$stage"
(cd dist && sha256sum "$stage.tar.gz" > "$stage.tar.gz.sha256")
