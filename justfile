# RewindOS dev tasks. Run `just` to list recipes.
# End users install via install.sh / AUR; this file is the local dev + install loop.

# list available recipes
_default:
    @just --list

# stop any running UI + daemon before reinstalling, so the binaries aren't busy
# and the rebuilt daemon is actually picked up (install-daemon's `systemctl
# start` is a no-op if the old daemon is still running).
# The `[r]ewindos` bracket trick keeps the pattern from matching the
# `sh -c '...rewindos...'` shell just spawns to run this recipe — a plain
# `pkill -f rewindos` SIGTERMs its own parent shell and aborts the recipe.
_stop-running:
    -@pkill -f '[r]ewindos' 2>/dev/null

# build + install the capture daemon as a systemd user service
install-daemon:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo install --path crates/rewindos-daemon --root ~/.local
    mkdir -p ~/.config/systemd/user
    cp systemd/rewindos-daemon.service ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable rewindos-daemon
    systemctl --user start rewindos-daemon
    # Install desktop file with full binary path for KWin ScreenShot2 authorization
    DAEMON_PATH=$(which rewindos-daemon)
    sed "s|^Exec=.*|Exec=$DAEMON_PATH|" systemd/com.rewindos.Daemon.desktop \
        > ~/.local/share/applications/com.rewindos.Daemon.desktop
    update-desktop-database ~/.local/share/applications/ 2>/dev/null || true

# rebuild + restart the daemon only
restart-daemon:
    cargo install --path crates/rewindos-daemon --root ~/.local
    systemctl --user restart rewindos-daemon

# follow daemon logs
logs:
    journalctl --user -u rewindos-daemon -f

# run the Tauri app in dev mode
dev:
    bun run tauri dev

# build the release UI binary (--no-bundle: we ship a tarball, not deb/rpm)
build:
    bun run tauri build --no-bundle

# full local install: stop running, build UI + daemon, install app + desktop + icons + autostart
install: _stop-running build install-daemon
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> Installing RewindOS UI app"
    mkdir -p ~/.local/bin
    cp target/release/rewindos ~/.local/bin/rewindos
    # Remove old desktop file from previous installs
    rm -f ~/.local/share/applications/com.rewindos.RewindOS.desktop
    # Desktop entry (app launcher) — filename must match Wayland app_id
    mkdir -p ~/.local/share/applications
    cp systemd/rewindos.desktop ~/.local/share/applications/io.github.jaypopat.rewindos.desktop
    sed -i "s|^Exec=.*|Exec=$HOME/.local/bin/rewindos|" ~/.local/share/applications/io.github.jaypopat.rewindos.desktop
    update-desktop-database ~/.local/share/applications/ 2>/dev/null || true
    # Install icons to hicolor theme
    mkdir -p ~/.local/share/icons/hicolor/{32x32,128x128,256x256,512x512}/apps
    cp src-tauri/icons/32x32.png      ~/.local/share/icons/hicolor/32x32/apps/io.github.jaypopat.rewindos.png
    cp src-tauri/icons/128x128.png    ~/.local/share/icons/hicolor/128x128/apps/io.github.jaypopat.rewindos.png
    cp src-tauri/icons/128x128@2x.png ~/.local/share/icons/hicolor/256x256/apps/io.github.jaypopat.rewindos.png
    cp src-tauri/icons/icon.png       ~/.local/share/icons/hicolor/512x512/apps/io.github.jaypopat.rewindos.png
    gtk-update-icon-cache ~/.local/share/icons/hicolor/ 2>/dev/null || true
    # Autostart on login (starts minimized in tray)
    mkdir -p ~/.config/autostart
    cp systemd/rewindos.desktop ~/.config/autostart/rewindos.desktop
    sed -i "s|^Exec=.*|Exec=$HOME/.local/bin/rewindos --minimized|" ~/.config/autostart/rewindos.desktop
    echo ""
    echo "==> RewindOS installed!"
    echo "    Daemon: enabled + started (systemd user service)"
    echo "    UI:     auto-starts minimized in tray on login"
    echo "    Hotkey: Ctrl+Shift+Space to open search"
    echo ""
    echo "    Run 'rewindos' or find RewindOS in your app launcher."

# run the installed binary, falling back to the dev build
run:
    #!/usr/bin/env bash
    if [ -f ~/.local/bin/rewindos ]; then
        ~/.local/bin/rewindos
    elif [ -f target/release/rewindos ]; then
        target/release/rewindos
    else
        echo "No built binary found. Run 'just build' first."
        exit 1
    fi

# remove everything `install` put in place
uninstall:
    #!/usr/bin/env bash
    systemctl --user stop rewindos-daemon 2>/dev/null || true
    systemctl --user disable rewindos-daemon 2>/dev/null || true
    rm -f ~/.config/systemd/user/rewindos-daemon.service
    rm -f ~/.config/autostart/rewindos.desktop
    rm -f ~/.local/share/applications/io.github.jaypopat.rewindos.desktop
    rm -f ~/.local/share/applications/com.rewindos.RewindOS.desktop
    rm -f ~/.local/share/applications/com.rewindos.Daemon.desktop
    rm -f ~/.local/bin/rewindos
    rm -f ~/.local/share/icons/hicolor/32x32/apps/io.github.jaypopat.rewindos.png
    rm -f ~/.local/share/icons/hicolor/128x128/apps/io.github.jaypopat.rewindos.png
    rm -f ~/.local/share/icons/hicolor/256x256/apps/io.github.jaypopat.rewindos.png
    rm -f ~/.local/share/icons/hicolor/512x512/apps/io.github.jaypopat.rewindos.png
    gtk-update-icon-cache ~/.local/share/icons/hicolor/ 2>/dev/null || true
    systemctl --user daemon-reload
    update-desktop-database ~/.local/share/applications/ 2>/dev/null || true
    echo "==> RewindOS uninstalled."
