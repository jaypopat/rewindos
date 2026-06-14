#!/usr/bin/env bash
# Unit tests for install.sh pure helpers. Sources the script (which must guard
# its `main` call) and asserts helper outputs. No network/sudo/systemd touched.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/install.sh"

fail=0
check() { # check <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    printf 'ok   - %s\n' "$1"
  else
    printf 'FAIL - %s\n      expected: %q\n      actual:   %q\n' "$1" "$2" "$3"
    fail=1
  fi
}
check_true()  { if "$@"; then printf 'ok   - %s\n' "$*"; else printf 'FAIL - %s\n' "$*"; fail=1; fi; }
check_false() { if "$@"; then printf 'FAIL - %s\n' "$*"; fail=1; else printf 'ok   - %s\n' "$*"; fi; }

# --- package manager mapping ---
check "apt for ubuntu"   apt    "$(pkg_mgr_for ubuntu debian)"
check "apt for debian"   apt    "$(pkg_mgr_for debian '')"
check "dnf for fedora"   dnf    "$(pkg_mgr_for fedora '')"
check "pacman for arch"  pacman "$(pkg_mgr_for arch '')"
check "unknown distro"   unknown "$(pkg_mgr_for void '')"
check "id_like fallback" apt    "$(pkg_mgr_for linuxmint ubuntu)"

# --- portal backend mapping ---
check "kde portal"     xdg-desktop-portal-kde      "$(portal_backend_pkg KDE)"
check "plasma portal"  xdg-desktop-portal-kde      "$(portal_backend_pkg plasma)"
check "gnome portal"   xdg-desktop-portal-gnome    "$(portal_backend_pkg GNOME)"
check "hyprland portal" xdg-desktop-portal-hyprland "$(portal_backend_pkg Hyprland)"
check "sway portal"    xdg-desktop-portal-wlr      "$(portal_backend_pkg sway)"
check "default portal" xdg-desktop-portal-gnome    "$(portal_backend_pkg '')"

# --- runtime deps include the engine + portal ---
deps_apt="$(runtime_deps apt GNOME)"
case "$deps_apt" in
  *tesseract-ocr*libwebkit2gtk-4.1-0*xdg-desktop-portal-gnome*) echo "ok   - apt deps shape" ;;
  *) echo "FAIL - apt deps shape: $deps_apt"; fail=1 ;;
esac

# --- sha256 verify ---
tmp="$(mktemp -d)"; echo "hello" > "$tmp/f"
sha="$(sha256sum "$tmp/f" | awk '{print $1}')"
check_true  verify_sha256 "$tmp/f" "$sha"
check_false verify_sha256 "$tmp/f" "deadbeef"
rm -rf "$tmp"

# --- version compare ---
check_true  version_gt 1.2.0 1.1.9
check_true  version_gt v2.0.0 v1.9.9
check_false version_gt 1.0.0 1.0.0
check_false version_gt 1.0.0 1.0.1

# --- config engine flip ---
tmp="$(mktemp -d)"
printf '[ocr]\nengine = "tesseract"\nenabled = true\n' > "$tmp/c1.toml"
set_config_engine "$tmp/c1.toml" paddleocr
check "flip existing engine line" 'engine = "paddleocr"' "$(grep -E '^engine' "$tmp/c1.toml")"
printf '[capture]\ninterval_seconds = 5\n' > "$tmp/c2.toml"   # no [ocr] section
set_config_engine "$tmp/c2.toml" paddleocr
check_true grep -qE '^\[ocr\]'              "$tmp/c2.toml"
check_true grep -qE '^engine = "paddleocr"' "$tmp/c2.toml"
rm -rf "$tmp"

# --- prompt non-interactive default is No (privacy-critical) ---
# Run under setsid so there is no controlling terminal: /dev/tty is then
# unreadable and prompt_yes_no MUST default to No (return non-zero).
if command -v setsid >/dev/null 2>&1; then
  if setsid bash -c "source '$SCRIPT_DIR/install.sh'; prompt_yes_no 'delete?'" </dev/null >/dev/null 2>&1; then
    printf 'FAIL - %s\n' "prompt_yes_no must default No with no tty"; fail=1
  else
    printf 'ok   - %s\n' "prompt_yes_no defaults No with no tty"
  fi
else
  echo "ok   - prompt_yes_no (skipped: setsid unavailable)"
fi

# --- installed_version reads the VERSION_FILE fallback ---
tmp="$(mktemp -d)"; OLD_DATA="$DATA_DIR"; OLD_BIN="$BIN_DIR"
DATA_DIR="$tmp"; VERSION_FILE="$tmp/INSTALLED_VERSION"; BIN_DIR="$tmp/bin"
echo "v1.2.3" > "$VERSION_FILE"
check "installed_version fallback" "v1.2.3" "$(installed_version)"
DATA_DIR="$OLD_DATA"; BIN_DIR="$OLD_BIN"; VERSION_FILE="$DATA_DIR/INSTALLED_VERSION"
rm -rf "$tmp"

# --- regression: source-guard must run main when piped via stdin (curl|bash) ---
# Reproduces the curl|bash path (script on stdin -> BASH_SOURCE empty); must NOT
# die with "BASH_SOURCE[0]: unbound variable" under set -u, and must reach main.
stdin_help="$(bash -s -- --help < "$SCRIPT_DIR/install.sh" 2>&1)"
case "$stdin_help" in
  *"RewindOS installer"*) echo "ok   - curl|bash (stdin) reaches main" ;;
  *) echo "FAIL - curl|bash (stdin) path broke: $stdin_help"; fail=1 ;;
esac

# --- chat option list (pure) ---
opts_empty="$(build_chat_options "")"
check "empty install: curated only (newline-joined)" \
  $'pull:llama3.2:3b\npull:qwen2.5:7b\npull:qwen2.5:14b\ncustom:\nskip:' \
  "$opts_empty"

opts_have="$(build_chat_options $'qwen2.5:7b\nmistral:latest')"
check "installed listed first, no dup of curated" \
  $'installed:qwen2.5:7b\ninstalled:mistral:latest\npull:llama3.2:3b\npull:qwen2.5:14b\ncustom:\nskip:' \
  "$opts_have"

opts_all="$(build_chat_options $'llama3.2:3b\nqwen2.5:7b\nqwen2.5:14b')"
check "all curated installed: no pull lines" \
  $'installed:llama3.2:3b\ninstalled:qwen2.5:7b\ninstalled:qwen2.5:14b\ncustom:\nskip:' \
  "$opts_all"

exit "$fail"
