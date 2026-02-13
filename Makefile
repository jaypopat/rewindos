.PHONY: install-daemon restart-daemon logs dev build package install run uninstall

install-daemon:
	cargo install --path crates/rewindos-daemon --root ~/.local
	mkdir -p ~/.config/systemd/user
	cp systemd/rewindos-daemon.service ~/.config/systemd/user/
	systemctl --user daemon-reload
	systemctl --user enable rewindos-daemon
	systemctl --user start rewindos-daemon
	@# Install desktop file with full binary path for KWin ScreenShot2 authorization
	@DAEMON_PATH=$$(which rewindos-daemon) && \
	sed "s|^Exec=.*|Exec=$$DAEMON_PATH|" systemd/com.rewindos.Daemon.desktop \
		> ~/.local/share/applications/com.rewindos.Daemon.desktop
	update-desktop-database ~/.local/share/applications/ 2>/dev/null || true

restart-daemon:
	cargo install --path crates/rewindos-daemon --root ~/.local
	systemctl --user restart rewindos-daemon

logs:
	journalctl --user -u rewindos-daemon -f

dev:
	bun run tauri dev

build:
	bun run tauri build

install: build install-daemon
	@echo "==> Installing RewindOS UI app"
	@# Copy the built binary
	mkdir -p ~/.local/bin
	cp target/release/rewindos ~/.local/bin/rewindos
	@# Desktop entry (app launcher)
	mkdir -p ~/.local/share/applications
	cp systemd/rewindos.desktop ~/.local/share/applications/com.rewindos.RewindOS.desktop
	sed -i "s|^Exec=.*|Exec=$(HOME)/.local/bin/rewindos|" ~/.local/share/applications/com.rewindos.RewindOS.desktop
	update-desktop-database ~/.local/share/applications/ 2>/dev/null || true
	@# Autostart on login (starts minimized in tray)
	mkdir -p ~/.config/autostart
	cp systemd/rewindos.desktop ~/.config/autostart/rewindos.desktop
	sed -i "s|^Exec=.*|Exec=$(HOME)/.local/bin/rewindos --minimized|" ~/.config/autostart/rewindos.desktop
	@echo ""
	@echo "==> RewindOS installed!"
	@echo "    Daemon: enabled + started (systemd user service)"
	@echo "    UI:     auto-starts minimized in tray on login"
	@echo "    Hotkey: Ctrl+Shift+Space to open search"
	@echo ""
	@echo "    Run 'rewindos' or find RewindOS in your app launcher."

run:
	@if [ -f ~/.local/bin/rewindos ]; then \
		~/.local/bin/rewindos; \
	elif [ -f target/release/rewindos ]; then \
		target/release/rewindos; \
	else \
		echo "No built binary found. Run 'make build' first."; \
		exit 1; \
	fi

uninstall:
	systemctl --user stop rewindos-daemon 2>/dev/null || true
	systemctl --user disable rewindos-daemon 2>/dev/null || true
	rm -f ~/.config/systemd/user/rewindos-daemon.service
	rm -f ~/.config/autostart/rewindos.desktop
	rm -f ~/.local/share/applications/com.rewindos.RewindOS.desktop
	rm -f ~/.local/share/applications/com.rewindos.Daemon.desktop
	rm -f ~/.local/bin/rewindos
	systemctl --user daemon-reload
	update-desktop-database ~/.local/share/applications/ 2>/dev/null || true
	@echo "==> RewindOS uninstalled."
