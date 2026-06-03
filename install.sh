#!/usr/bin/env bash
# RewindOS installer — install / --update / --uninstall / --with-paddleocr.
# Privacy-first: inspect this script before running it.
set -euo pipefail

REPO="jaypopat/rewindos"
ASSET="rewindos-linux-x86_64.tar.gz"
APP_ID="com.jay.rewindos"

BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
ICON_BASE="$HOME/.local/share/icons/hicolor"
UNIT_DIR="$HOME/.config/systemd/user"
AUTOSTART_DIR="$HOME/.config/autostart"
DATA_DIR="$HOME/.rewindos"
VERSION_FILE="$DATA_DIR/INSTALLED_VERSION"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# ---- pure helpers (unit-tested in tests/install.test.sh) ----

# pkg_mgr_for <ID> <ID_LIKE> -> apt|dnf|pacman|unknown
pkg_mgr_for() {
  local id="${1:-}" like="${2:-}"
  case " $id $like " in
    *" debian "*|*" ubuntu "*) echo apt ;;
    *" fedora "*|*" rhel "*|*" centos "*) echo dnf ;;
    *" arch "*) echo pacman ;;
    *) echo unknown ;;
  esac
}

# detect_pkg_mgr -> reads /etc/os-release
detect_pkg_mgr() {
  local id="" like=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release 2>/dev/null; echo "${ID:-}")"
    # shellcheck disable=SC1091
    like="$(. /etc/os-release 2>/dev/null; echo "${ID_LIKE:-}")"
  fi
  pkg_mgr_for "$id" "$like"
}

# portal_backend_pkg <XDG_CURRENT_DESKTOP> -> upstream portal backend package
portal_backend_pkg() {
  local d; d="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$d" in
    *kde*|*plasma*)         echo "xdg-desktop-portal-kde" ;;
    *gnome*)                echo "xdg-desktop-portal-gnome" ;;
    *hyprland*)             echo "xdg-desktop-portal-hyprland" ;;
    *sway*|*wlroots*|*wlr*) echo "xdg-desktop-portal-wlr" ;;
    *)                      echo "xdg-desktop-portal-gnome" ;;
  esac
}

# runtime_deps <pkg_mgr> <desktop> -> space-separated package list
runtime_deps() {
  local pm="$1" desktop="$2" portal
  portal="$(portal_backend_pkg "$desktop")"
  case "$pm" in
    apt)    echo "tesseract-ocr tesseract-ocr-eng libwebkit2gtk-4.1-0 libayatana-appindicator3-1 pipewire xdg-desktop-portal $portal" ;;
    dnf)    echo "tesseract tesseract-langpack-eng webkit2gtk4.1 libayatana-appindicator-gtk3 pipewire xdg-desktop-portal $portal" ;;
    pacman) echo "tesseract tesseract-data-eng webkit2gtk-4.1 libayatana-appindicator pipewire xdg-desktop-portal $portal" ;;
    *)      echo "" ;;
  esac
}

# verify_sha256 <file> <expected_hex>
verify_sha256() {
  local actual; actual="$(sha256sum "$1" | awk '{print $1}')"
  [[ "$actual" == "$2" ]]
}

# version_gt <a> <b> -> true if a > b (leading 'v' stripped, sort -V)
version_gt() {
  local a="${1#v}" b="${2#v}"
  [[ "$a" != "$b" && "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -1)" == "$a" ]]
}

# set_config_engine <config_path> <engine> -> set [ocr].engine in a TOML config
set_config_engine() {
  local cfg="$1" engine="$2"
  mkdir -p "$(dirname "$cfg")"
  if [[ -f "$cfg" ]] && grep -qE '^[[:space:]]*engine[[:space:]]*=' "$cfg"; then
    sed -i -E "s|^[[:space:]]*engine[[:space:]]*=.*|engine = \"$engine\"|" "$cfg"
  elif [[ -f "$cfg" ]] && grep -qE '^\[ocr\]' "$cfg"; then
    sed -i -E "/^\[ocr\]/a engine = \"$engine\"" "$cfg"
  else
    printf '\n[ocr]\nengine = "%s"\n' "$engine" >> "$cfg"
  fi
}

# ---- side-effecting helpers ----

run_pkg_install() { # run_pkg_install <pkg_mgr> <pkgs...>
  local pm="$1"; shift
  case "$pm" in
    apt)    sudo apt-get update -y && sudo apt-get install -y "$@" ;;
    dnf)    sudo dnf install -y "$@" ;;
    pacman) sudo pacman -S --needed --noconfirm "$@" ;;
    *)      return 1 ;;
  esac
}

install_deps() { # install_deps <pkg_mgr> <desktop>
  local pm="$1" desktop="$2" pkgs
  pkgs="$(runtime_deps "$pm" "$desktop")"
  if [[ "$pm" == "unknown" || -z "$pkgs" ]]; then
    warn "Unsupported distro — install these packages manually, then re-run:"
    warn "  tesseract, webkit2gtk-4.1, libayatana-appindicator, pipewire, xdg-desktop-portal + your desktop's backend"
    return 0
  fi
  if ! command -v sudo >/dev/null; then
    warn "sudo not found — install these packages manually: $pkgs"
    return 0
  fi
  log "Installing system dependencies: $pkgs"
  # shellcheck disable=SC2086
  run_pkg_install "$pm" $pkgs || warn "Some dependencies failed to install; continuing."
}

# latest_asset_url -> prints "<tag> <tarball_url> <sha_url>" for the latest release
latest_asset_url() {
  local api="https://api.github.com/repos/$REPO/releases/latest" json
  json="$(curl -fsSL "$api")" || return 1
  local tag tarball sha
  tag="$(printf '%s' "$json" | grep -oE '"tag_name":\s*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
  tarball="$(printf '%s' "$json" | grep -oE "https://[^\"]*$ASSET" | head -1)"
  sha="$(printf '%s' "$json" | grep -oE "https://[^\"]*$ASSET.sha256" | head -1)"
  [[ -n "$tag" && -n "$tarball" && -n "$sha" ]] || return 1
  printf '%s %s %s\n' "$tag" "$tarball" "$sha"
}

# download_and_extract <staging_dir> -> echoes the resolved tag; extracts tarball into staging
download_and_extract() {
  local stage="$1" tag tarball sha
  read -r tag tarball sha < <(latest_asset_url) || die "Could not find a release asset. Manual download: https://github.com/$REPO/releases/latest"
  log "Downloading RewindOS $tag..."
  curl -fsSL "$tarball" -o "$stage/$ASSET" || die "Download failed."
  curl -fsSL "$sha"     -o "$stage/$ASSET.sha256" || die "Checksum download failed."
  local expected; expected="$(awk '{print $1}' "$stage/$ASSET.sha256")"
  verify_sha256 "$stage/$ASSET" "$expected" || die "Checksum mismatch — refusing to install."
  tar -C "$stage" -xzf "$stage/$ASSET" || die "Extraction failed."
  echo "$tag"
}

# place_files <extracted_dir>
place_files() {
  local src="$1"
  mkdir -p "$BIN_DIR" "$APP_DIR" "$UNIT_DIR" "$AUTOSTART_DIR" "$DATA_DIR"
  install -m755 "$src/rewindos"        "$BIN_DIR/rewindos"
  install -m755 "$src/rewindos-daemon" "$BIN_DIR/rewindos-daemon"

  # systemd unit (uses %h, no rewrite needed)
  install -m644 "$src/rewindos-daemon.service" "$UNIT_DIR/rewindos-daemon.service"

  # app launcher — rewrite Exec to absolute path
  sed "s|^Exec=.*|Exec=$BIN_DIR/rewindos --minimized|" "$src/rewindos.desktop" \
    > "$APP_DIR/$APP_ID.desktop"

  # daemon desktop file — REQUIRED for KDE KWin ScreenShot2 authorization
  sed "s|^Exec=.*|Exec=$BIN_DIR/rewindos-daemon|" "$src/com.rewindos.Daemon.desktop" \
    > "$APP_DIR/com.rewindos.Daemon.desktop"

  # autostart (UI minimized in tray on login)
  sed "s|^Exec=.*|Exec=$BIN_DIR/rewindos --minimized|" "$src/rewindos.desktop" \
    > "$AUTOSTART_DIR/rewindos.desktop"

  # icons
  local sizes=(32x32 128x128 256x256 512x512)
  local srcs=(32x32.png 128x128.png 128x128@2x.png icon.png)
  local i
  for i in "${!sizes[@]}"; do
    mkdir -p "$ICON_BASE/${sizes[$i]}/apps"
    install -m644 "$src/icons/${srcs[$i]}" "$ICON_BASE/${sizes[$i]}/apps/$APP_ID.png"
  done

  update-desktop-database "$APP_DIR" 2>/dev/null || true
  gtk-update-icon-cache "$ICON_BASE" 2>/dev/null || true
}

smoke_check() {
  # The single-binary glibc/webkit floor means a too-old distro fails to exec.
  if ! "$BIN_DIR/rewindos-daemon" --version >/dev/null 2>&1; then
    die "The prebuilt binary won't run on this system (likely too old — needs a newer glibc / webkit2gtk-4.1).
See https://github.com/$REPO#building-from-source to build locally."
  fi
}

enable_service() {
  systemctl --user daemon-reload
  if ! systemctl --user enable --now rewindos-daemon.service 2>/dev/null; then
    warn "Could not enable the systemd user service automatically. Enable it with:"
    warn "  systemctl --user enable --now rewindos-daemon.service"
  fi
}

do_install() { # do_install <with_paddleocr:0|1>
  local with_paddle="${1:-0}"
  [[ "$(uname -m)" == "x86_64" ]] || die "Unsupported architecture $(uname -m); x86_64 only for now."

  install_deps "$(detect_pkg_mgr)" "${XDG_CURRENT_DESKTOP:-}"

  local stage tag; stage="$(mktemp -d)"; trap 'rm -rf "$stage"' RETURN
  tag="$(download_and_extract "$stage")"
  place_files "$stage/rewindos-linux-x86_64"
  smoke_check
  echo "$tag" > "$VERSION_FILE"
  enable_service

  if [[ "$with_paddle" == "1" ]]; then
    do_paddleocr
  else
    maybe_prompt_paddleocr
  fi

  log "RewindOS $tag is installed and capturing."
  log "Open it from your app launcher, or run: $BIN_DIR/rewindos"
  log "(If 'rewindos' isn't found, add ~/.local/bin to your PATH.)"
  log "On GNOME, install the 'Window Calls Extended' extension for app/window tracking."
}

do_paddleocr()         { die "do_paddleocr implemented in Task 6"; }
maybe_prompt_paddleocr() { :; }
do_update()            { die "do_update implemented in Task 5"; }
do_uninstall()         { die "do_uninstall implemented in Task 5"; }
print_help()           { echo "usage: install.sh [--update|--uninstall|--with-paddleocr|--help]"; }

main() {
  local mode="install" with_paddle=0 arg
  for arg in "$@"; do
    case "$arg" in
      --update)        mode="update" ;;
      --uninstall)     mode="uninstall" ;;
      --with-paddleocr) with_paddle=1 ;;
      --help|-h)       mode="help" ;;
      *) die "Unknown option: $arg (try --help)" ;;
    esac
  done
  case "$mode" in
    install)   do_install "$with_paddle" ;;
    update)    do_update ;;
    uninstall) do_uninstall ;;
    help)      print_help ;;
  esac
}

# Only run when executed, not when sourced by tests.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
