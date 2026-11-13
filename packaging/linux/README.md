# Native Linux ARM64 builds (including Asahi)

The build uses a native Ubuntu 24.04 ARM64 container, not an x86 cross compiler
or QEMU. The same `Containerfile` and script run on Asahi and GitHub's
`ubuntu-24.04-arm` runner. Handy uses that runner too:
<https://github.com/cjpais/Handy/blob/main/.github/workflows/build.yml>.

## Build locally on an ARM64 machine

From the repository root, with rootless Podman:

```sh
podman build -f packaging/linux/Containerfile -t localhost/rewindos-builder .
podman run --name rewindos-build --userns=keep-id \
  --user "$(id -u):$(id -g)" \
  -e HOME=/work/.build-home \
  -e CARGO_HOME=/work/.build-home/cargo \
  -e CARGO_BUILD_JOBS=2 \
  -v "$PWD:/work:Z" localhost/rewindos-builder
podman run --rm --network none --userns=keep-id \
  --user "$(id -u):$(id -g)" -e HOME=/work/.build-home \
  -v "$PWD:/work:Z" localhost/rewindos-builder \
  python3 scripts/smoke-linux-ui.py
```

Run build and smoke containers sequentially: `:Z` gives the workspace a private
SELinux label, so a second container mounting it with `:Z` will revoke the first
container's access. Do not overlap them.

Choose a fresh container name for another build, or start an existing stopped
build container. Docker uses the same commands without `--userns=keep-id` and,
on hosts without SELinux, without the `:Z` volume suffix. The dependency cache
and test data stay in the ignored `.build-home/` directory. Two build jobs limit
memory pressure on a laptop. There is no host package install, service
activation, display mount, session bus mount, or screen-capture permission.

Output:

- `dist/rewindos-linux-aarch64.tar.gz`
- `dist/rewindos-linux-aarch64.tar.gz.sha256`
- An extracted copy at `dist/rewindos-linux-aarch64/`

The archive contains both binaries, desktop/service files, icons, the optional
PaddleOCR worker, license, build information, and build-container `ldd` reports.
It is not an AppImage and does not bundle system libraries.

## Why these dependencies and settings?

- Ubuntu 24.04 provides the PipeWire/SPA API the daemon needs; upstream already
  found Ubuntu 22.04 too old. glibc 2.39 is the intended compatibility floor.
- WebKitGTK 4.1, GTK 3, AppIndicator, librsvg, PipeWire, ALSA, Opus, D-Bus,
  OpenSSL, Clang/libclang, CMake, and a C/C++ compiler cover Tauri and the daemon's
  native dependencies. Tesseract and English language data support default OCR.
- Rust 1.100.0 and Bun 1.4.4 are explicit toolchain versions. Cargo and Bun use
  their checked-in lockfiles. `GGML_NATIVE=OFF` prevents Whisper's C++ backend
  from requiring the builder CPU's optional instructions.
- Linux ARM64 is not enough for Asahi: its kernel uses 16 KiB pages. The linker
  gets `-z max-page-size=65536`, and `check-asahi-elf.py` checks both binaries'
  AArch64 machine type and load-segment alignment. System libraries still come
  from the target distribution. Actual execution on Asahi remains necessary.
- Frontend tests and all Rust workspace tests run before packaging. Model- and
  desktop-dependent tests marked ignored by upstream remain ignored.
- A separate, network-disabled UI smoke test creates a private X display,
  session bus, and HOME. It checks that a RewindOS window appears and stays up
  for ten seconds. Capture and usage heartbeat are disabled. This does not
  prove real Wayland capture, OCR, audio, or model inference.

## Try the result on Asahi

First check the archive:

```sh
cd dist
sha256sum -c rewindos-linux-aarch64.tar.gz.sha256
cd rewindos-linux-aarch64
./rewindos-daemon --version
ldd ./rewindos
ldd ./rewindos-daemon
./rewindos
```

Run the UI command from a terminal in the laptop's graphical session. It opens
the app but does not install or enable the daemon. Starting the daemon separately
is an explicit next step: it can request screen access and begin recording.
The upstream systemd/desktop files are included for later installation, not
activated by this build.

Runtime packages on ordinary Fedora include `webkit2gtk4.1`, GTK 3,
`libappindicator-gtk3` or `libayatana-appindicator-gtk3`, `pipewire`, `opus`,
`tesseract`, `tesseract-langpack-eng`, and the desktop's `xdg-desktop-portal`
backend. Check the actual `ldd` output as well. On Fedora Atomic/Asahi Bluefin,
add missing runtime packages through the OS image's normal declarative package
configuration (or use a desktop-integrated Distrobox); do not run `dnf install`
against the immutable host. The build container's successful tests do not
install these on the laptop.

**Do not run upstream's `scripts/install.sh` for this artifact.** It still
selects upstream's x86-64 release and activates capture/autostart. This test
build intentionally leaves the existing install path alone. The app's update
asset selection now follows the compiled architecture and rejects releases
that lack a matching asset. Update checks still target upstream, which may not
publish ARM64 builds; an extracted source build cannot self-update. Use a new
artifact from this workflow to update it.

Usage heartbeat defaults to enabled upstream. Before starting a real daemon,
set `[privacy] usage_heartbeat = false` in `~/.rewindos/config.toml` if you do not
want those requests. In-app update checks also contact upstream's update proxy;
heartbeat opt-out does not disable update checks. Optional semantic search needs
Ollama/models; meeting transcription needs a Whisper model. Neither is installed
or downloaded by this build.

## Fedora RPM and local rpm-ostree overlay

The workflow also builds `rewindos-*.aarch64.rpm` in Fedora 44. RPM's ELF scanner
records the actual shared-library requirements; explicit dependencies install
Tesseract, English OCR data, AppIndicator, PipeWire, and the portal framework.
A Fedora container installs the RPM and checks its files, daemon, UI and a known
OCR fixture. The service uses `/usr/bin/rewindos-daemon`, not a home-directory
binary. Installation does not enable its service or create autostart entries.

Download the successful workflow's `rewindos-linux-aarch64` artifact, extract it
into one directory on Asahi, and verify its checksum files there:

```sh
sha256sum -c ./*.rpm.sha256
sudo rpm-ostree install ./rewindos-*.aarch64.rpm
```

This stages a deployment and pulls Tesseract from Fedora's configured signed
repositories. English data already present in the base satisfies that dependency.
Reboot when ready, then run:

```sh
rpm -q rewindos tesseract tesseract-langpack-eng
/usr/bin/rewindos-daemon --version
tesseract --list-langs
/usr/bin/rewindos
```

A reboot is not automatic. Stop any source-build daemon before starting the
packaged daemon; the package does not migrate or remove files in `~/.local`.
Existing user units, launchers and PATH entries can override the package: inspect
`systemctl --user cat rewindos-daemon.service` and `command -v rewindos`.
User data remains in `~/.rewindos`; do not delete it. To opt into the packaged
service after confirming the unit path, use
`systemctl --user enable --now rewindos-daemon.service`.

Tesseract is the default because it has Fedora-native ARM64 packages and needs
no extra Python environment or model bootstrap. PaddleOCR remains optional;
this package neither installs nor selects it. The fixed local-RPM overlay does
not auto-track GitHub: stage a newer downloaded RPM explicitly to update it.
RPMs are currently unsigned; verify the artifact came from the expected repository,
workflow commit and successful run. Its checksum is an integrity check, not a
publisher signature. Do not disable Fedora dependency signature verification.

For Tesseract alone, the same supported host overlay is
`sudo rpm-ostree install tesseract` (plus a reboot); the English language pack
is already installed on the inspected Asahi deployment. Including it as the
RewindOS RPM's dependency avoids a separate overlay request and a second reboot.
For a future permanent image default, add it to the BlueBuild recipe instead;
no OS image change is required for this optional app overlay.

## GitHub Actions

`.github/workflows/linux-aarch64.yml` builds the container, runs the same build
and isolated UI test, and uploads the archive/checksum as a 14-day workflow
artifact. It runs on pushes to `master`, relevant pull requests,
and manual dispatch. It needs only `contents: read`; it neither publishes a
release nor touches AUR. No version-tag gate can silently skip compilation.

The Ubuntu image tag and apt repositories remain moving inputs; this is a
repeatable procedure, not a claim of bit-for-bit reproducibility. Rustup's
bootstrap script and Bun's release archive arrive over HTTPS; the recipe does
not independently authenticate them. Record the built container image ID or
digest with any distributed test artifact. Source builds and local checksums
are not a dependency security audit or a publisher signature.
