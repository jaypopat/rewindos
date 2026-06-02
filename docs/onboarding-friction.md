# RewindOS — Onboarding Friction & Fix Plan

**Goal:** Take RewindOS from "works on Jay's machine" to "any Linux user can install it and have it Just Work in under 5 minutes" — a real local-first, privacy-minded alternative to omi/desktop.

**Date:** 2026-06-02
**Status:** Audit + prioritized fix list

---

## TL;DR — Is it hardcoded for Jay or generic?

**It's ~90% generic already.** The core plumbing is portable:

- All runtime paths use `dirs::home_dir()` + tilde resolution (`~/.rewindos/...`), not literal `/home/jay`.
- `config.toml` auto-creates on first run with sensible defaults — no hand-editing required to start.
- The systemd unit uses `%h` for the home dir, not a hardcoded path.
- AI (Ollama) is optional and degrades gracefully to keyword search.

**The real problem is not portability — it's _silent failure_ and _invisible state_.** A new user can do everything right, have a dependency missing, and get zero feedback in the UI. They find out via `journalctl`. That's the gap between this and a shippable product.

There are exactly **two literal "jay" blockers** (the app identifier and a GitHub URL), and they're trivial to fix.

---

## Severity 1 — Hard blockers (must fix before any public release)

These break for someone who isn't Jay, or leave a new user with a broken app and no explanation.

### 1.1 Rename the `com.jay.rewindos` app identifier → `com.rewindos.app` (or `io.rewindos.RewindOS`)
Personal namespace baked into the public product identity. Affects packaging, icons, window matching, and the default privacy exclusion list.

- `src-tauri/tauri.conf.json:5` — `"identifier": "com.jay.rewindos"`
- `systemd/rewindos.desktop:5` — `Icon=com.jay.rewindos`
- `systemd/rewindos.desktop:8` — `StartupWMClass=com.jay.rewindos`
- `crates/rewindos-core/src/config.rs:167` — `"com.jay.rewindos"` in `excluded_apps` default (self-exclusion will silently stop working once renamed — update both)
- `crates/rewindos-daemon/src/window_info/mod.rs:102` — comment + test
- Makefile + `scripts/postinstall.sh` write `com.jay.rewindos.desktop` — keep the desktop filename in sync with the new identifier.

> Pick the canonical identifier once and grep the whole tree for `com.jay.rewindos` to catch every reference.

### 1.2 Fix the GitHub URL placeholder
- `systemd/rewindos-daemon.service:3` — `Documentation=https://github.com/jay/rewindos`
- `crates/rewindos-daemon/src/detect.rs:291` — error message points users to `https://github.com/jay/rewindos/issues`

These will send users to a 404. Point them at the real public repo.

### 1.3 Tesseract is mandatory but fails silently — surface it
OCR is the core feature (no OCR → search is empty), yet a missing `tesseract` binary produces no UI signal — capture keeps running and silently indexes nothing.

- `crates/rewindos-core/src/ocr.rs:81` — `Command::new("tesseract")` errors with `CoreError::Ocr` but only to logs.
- **Fix:** On daemon startup, probe for the configured OCR binary. If missing, expose it over D-Bus as a health flag and show a blocking banner in the UI: _"OCR engine not found — install `tesseract-ocr` to enable search. [Copy command]"_. Do not let the app appear "running" while it's actually indexing nothing.

### 1.4 No dependency pre-flight — failures look like crashes
A new user hits a cryptic compile error (`libpipewire-0.3-dev` / `libclang-dev` missing) or a silent runtime no-op, with no guidance.

- **Fix (build-time):** Add `make doctor` (or run it at the top of `make install`) that checks for `tesseract`, `libpipewire-0.3-dev`, `libclang-dev`, `libdbus-1-dev`, `pkg-config`, and the correct `xdg-desktop-portal-<backend>`, printing the exact `apt`/`dnf`/`pacman` command for anything missing.
- **Fix (runtime):** Daemon already detects the desktop environment and the right portal backend in `capture/portal.rs:613` — but only logs it. Pipe that diagnostic to the UI.

---

## Severity 2 — Major friction (fix for a good first-run experience)

The app technically works, but the user can't tell what's happening or why something's broken.

### 2.1 No onboarding / first-run flow
`src/App.tsx` jumps straight to the Dashboard. There's no welcome, no permission priming, no "capture has started" confirmation.

**Fix — minimal 3-step first-run wizard** (shown once, gated on a `first_run` flag in config or a marker file):
1. **Welcome + privacy promise** — "100% local. Nothing leaves your machine." Set the tone; it's the differentiator vs cloud tools.
2. **System check** — live status of: daemon running, screen-capture permission granted, OCR engine found, (optional) Ollama reachable. Green/red rows with one-click fixes.
3. **Grant capture permission** — trigger the `xdg-desktop-portal` dialog from a button so the user understands what the OS prompt is for, instead of it firing unexpectedly from the background daemon.

### 2.2 Daemon status is invisible / dev-focused
When the daemon is offline, the UI tooltip says _"Run: `cargo run -p rewindos-daemon`"_ — meaningless to an end user who installed a package.

- `src-tauri/src/lib.rs` (DaemonPanel area) — replace with end-user guidance: show `systemctl --user status rewindos-daemon`, a **Restart daemon** button (shell out to `systemctl --user restart`), and "capture auto-starts on next login."
- Surface a persistent, glanceable capture indicator (capturing / paused / offline + frames today) so users know it's alive. (A tray indicator already exists per recent commits — make sure the main window mirrors it.)

### 2.3 Chat is enabled by default but silently dies without Ollama
`ChatConfig.enabled = true` (`config.rs:127`) but most users won't have Ollama. The Ask view will just return nothing useful with no explanation.

**Fix — pick one:**
- **Recommended:** Default chat to a graceful state — if Ollama is unreachable, the Ask view shows an inline setup card: _"AI chat needs Ollama (runs locally). [Install guide] · [I've installed it — recheck]"_ instead of failing silently.
- Add an **Ollama status panel** in Settings → AI (`src/features/settings/tabs/AITab.tsx`): reachability check + list of installed models + a **Pull model** button (the daemon already auto-pulls via `embedding.rs:105`; expose that over D-Bus instead of making users use the Ollama CLI).

### 2.4 Settings UI lets users configure AI but gives zero feedback
`AITab.tsx` lets users type an Ollama URL and model name with no validation — no "is it reachable?", no "does this model exist?", no "pull it" affordance. Same for OCR: no check that the tesseract binary / PaddleOCR Python env exists.

- **Fix:** Add a "Test connection" button next to the Ollama URL and a status dot next to each AI/OCR feature.

### 2.5 "Why is semantic search off?"
`SemanticConfig.enabled = false` by default (conservative, fine) — but the UI never explains the tradeoff or how to turn it on. Add a one-line explainer + an enable flow that checks Ollama first.

---

## Severity 3 — Polish (raises trust, especially for a privacy tool)

### 3.1 Storage transparency
Retention defaults to 90 days (~19 GB per the README) with no in-app disk-usage display. For a tool that quietly screenshots all day, showing **current disk usage + projected growth** in Settings → Storage builds trust and prevents "why is my disk full" surprises.

### 3.2 Global hotkey conflict
`Ctrl+Shift+Space` may collide with existing bindings. It's configurable, but add a "rebind" affordance in onboarding/settings and detect failed registration.

### 3.3 Packaging reach
Currently only `.deb` / `.rpm` bundle targets are configured (`tauri.conf.json`). To actually reach Linux users:
- **AppImage** (distro-agnostic, no root) — highest-leverage addition for "download and run."
- **Flatpak** (Flathub) — the discovery channel for desktop Linux; sandbox + portal model fits the privacy story perfectly.
- **AUR** package for Arch users.
- Note the sandbox implication: a Flatpak build must declare the screen-cast portal and D-Bus access; verify the daemon/UI split works inside the sandbox.

### 3.4 Daemon ↔ UI lifecycle
The daemon is a separate systemd user service; the Tauri app only talks to it over D-Bus and never starts it. If the service is stopped/failed, the UI is inert. Consider: UI offers to start the service if it detects it installed-but-stopped.

### 3.5 Portal permission re-prompt is silent
If a user revokes screen-capture permission in system settings, the daemon quietly re-prompts on next start (`capture/portal.rs`). A small UI note ("re-authorizing screen capture…") avoids confusion.

---

## What's already good (don't touch)

- **Path handling is fully portable** — `dirs::home_dir()` + tilde resolution everywhere; `~/.rewindos/{config.toml,rewindos.db,screenshots,logs}`. No literal user paths in runtime code (only in tests, which is fine).
- **Config auto-creates with sane defaults** (`config.rs:217`) — no hand-editing to start.
- **AI is genuinely optional** — keyword search via SQLite FTS5 works with zero AI deps; Ollama failures degrade gracefully (`main.rs:528`, `chat_context.rs:51`).
- **systemd unit is portable** — uses `%h`, declares correct deps (pipewire, dbus, graphical-session).
- **Portal backend auto-detection per DE** already exists (`capture/portal.rs:613`) — it just needs to reach the UI.
- **Privacy defaults are sensible** — password managers and incognito/lock-screen patterns excluded out of the box.

---

## Recommended fix order (minimal path to shippable)

1. **S1.1 + S1.2** — kill the two `jay` references (1 hour, pure find-replace + identifier decision).
2. **S1.3 + S1.4** — dependency doctor + surface missing OCR/portal to the UI. This single change converts the most common "it's broken and I don't know why" into "here's the command to fix it."
3. **S2.1 + S2.2** — first-run wizard with system check + real daemon status. This is the make-or-break for first impressions.
4. **S2.3 + S2.4** — graceful Ollama story (status + pull button). Makes the AI features discoverable instead of silently dead.
5. **S3.3** — AppImage + Flatpak so people can actually get it.
6. Everything else as polish.

**North-star test:** A friend on vanilla Ubuntu/Fedora/Arch, who has never seen the repo, can install RewindOS, grant one permission, and search their screen history within 5 minutes — and at every step where something's missing, the app tells them exactly what to do. No `journalctl`, no editing `config.toml`, no guessing.

---

## Appendix — Lessons from omi/desktop

I studied `omi/desktop` (the closest comparable). Key context that shapes how we should think about it:

**omi is NOT actually local-first for AI.** It's a native macOS (Swift/SwiftUI) app whose LLM inference runs on omi's remote backend, or on the user's own cloud API keys (OpenAI/Anthropic/Gemini/Deepgram) via a "Bring Your Own Keys" step. Transcription goes to Deepgram or their servers. Their onboarding even has a "Trust" step trying to *reassure* users about data leaving the device.

**→ This is RewindOS's wedge, not a gap to close.** RewindOS runs everything on-device via Ollama + local Tesseract + local SQLite. We are *more* private than omi, not less. Lean into it: the first-run screen should say, plainly, **"Nothing ever leaves your machine. No account, no cloud, no API keys."** That's a claim omi literally cannot make.

### Patterns worth stealing (all translate to our Tauri/Linux stack)

1. **Auto-advance after a permission is granted.** omi polls permission state every 1s *and* re-checks on window re-focus; the moment the OS grants screen capture, it shows "Permission granted. Continuing…" and advances after ~350ms. For us: after the `xdg-desktop-portal` dialog returns success, auto-advance the wizard. Eliminates the "ok… now what?" dead-end. (omi: `OnboardingPermissionStepView.swift`)

2. **Re-check on window focus, not just on a timer.** When the OS permission dialog steals focus and returns, re-probe state on the Tauri window's focus event. Catches grants the user made in system settings while we weren't looking.

3. **Persistent, resumable onboarding.** omi stores `onboardingStep` so a user who quits mid-setup resumes where they left off. We should persist a `first_run` / step marker in config so closing the app doesn't restart setup.

4. **Mandatory vs. skippable steps.** Only screen-capture permission is non-skippable in omi; mic/disk/etc. have Skip buttons. For us: screen-capture is the only hard requirement; OCR-language, Ollama, and hotkey customization should all be skippable-with-a-note ("you can enable this later in Settings").

5. **Real-time validation with a status chip.** omi's BYOK step validates each API key inline (Checking… → Valid/Invalid). Our equivalent is **"Test connection"** for the Ollama URL and a live status dot for OCR/daemon/portal — directly addresses friction items 2.2–2.4 above. The pattern is the same; the thing being validated is a local service instead of a cloud key.

6. **Per-condition contextual help.** omi tailors each permission screen to that permission's known quirks (e.g. the macOS 15 screen-capture toggle bug, showing the user's email so they can find the right Settings row). Our analog: detect the desktop environment and show the *exact* portal backend package to install (`xdg-desktop-portal-kde` vs `-gnome` vs `-hyprland`) — the daemon already computes this in `capture/portal.rs:613`, we just need to show it.

7. **Progress + counts for long operations.** omi shows "X files indexed" during its scan. Our equivalent: during initial Ollama model pull (the daemon already pulls in `embedding.rs:105`), show download progress instead of a silent multi-hundred-MB wait; and show "N screenshots indexed today" so the user sees capture is actually working.

### What does NOT apply

- Code signing / notarization / Gatekeeper / DMG / Sparkle — all macOS-specific. Our distribution story is AppImage + Flatpak + `.deb`/`.rpm` (Severity 3.3).
- omi's 19-step flow is too long for us. We're a screenshot-search tool, not a personal-data-graph product — **aim for 3 steps** (welcome/privacy → system check → grant capture), with optional AI setup deferred to Settings.
- BYOK / freemium / accounts — irrelevant. RewindOS has no backend and no account, which is the whole point.
