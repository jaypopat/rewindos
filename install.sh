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

# ---- main (filled in by later tasks) ----
main() {
  die "not yet implemented"
}

# Only run when executed, not when sourced by tests.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
