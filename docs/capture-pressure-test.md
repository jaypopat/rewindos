# Capture Path Pressure-Test — Across Compositors

**Date:** 2026-06-02
**Scope:** Screen-capture + active-window detection, traced through `crates/rewindos-daemon/src/capture/{portal,kwin,mod}.rs`, `detect.rs`, and `window_info/*`.
**Method:** Direct code read, not runtime testing. Findings tagged **[code-confirmed]** (provable from the source) or **[needs-hardware]** (depends on the specific compositor/GPU at runtime).

This is the part of RewindOS that decides whether the product is real. A flaky capture path silently undermines the entire pitch — and the worst failures here are *silent*, which is exactly the failure class that loses users.

---

## The headline (read this first)

**On default GNOME Wayland — the single most common Linux desktop — the privacy exclusion list silently does nothing, so password managers, incognito windows, and the lock screen get captured and OCR'd.** That's not a polish bug; it's a privacy-first tool failing open on privacy, on the most popular platform, with no signal to the user. Details in §3. Fix this before any public release.

Two more silent failures sit right behind it: capture can report "healthy/green" while delivering zero frames (§2.4), and multi-monitor users silently capture only one screen (§2.2).

---

## 1. Capture backend selection (`detect.rs:133`)

| Environment | Capture backend | Notes |
|---|---|---|
| KDE Plasma | KWin `ScreenShot2` D-Bus, else portal | Probes `org.kde.KWin` introspection first |
| GNOME / Hyprland / Sway / COSMIC (Wayland) | xdg-desktop-portal + PipeWire | The main path |
| **X11 (any DE)** | **none — hard error** | `detect.rs:155` returns `Unavailable` |

**Finding 1.1 — X11 is a hard wall [code-confirmed].** Any X11 session gets `CaptureError::Unavailable` and the daemon's capture never starts. X11 is still a large chunk of real Linux desktops (NVIDIA holdouts, "GNOME on Xorg" login option, KDE X11 sessions, older distros). X11 screen capture is *trivial* (XGetImage / XShm / XComposite) compared to the Wayland dance — and supporting it would massively widen the addressable user base. Whether or not you support it, the current message is log-only; an X11 user just sees a dead app. **Decision needed:** support X11, or detect it and tell the user plainly in the UI ("RewindOS needs a Wayland session — log out and pick the Wayland session at login").

---

## 2. The portal + PipeWire path (`portal.rs`) — GNOME / Hyprland / Sway / COSMIC

### 2.1 First-run picker + auto-start collide [code-confirmed + needs-hardware]
`select_sources(..., SourceType::Monitor, multiple=false, restore_token, PersistMode::ExplicitlyRevoked)` (`portal.rs:115`). On first run with no token, **the portal shows an interactive "Share your screen" picker**. The daemon is a systemd user service that auto-starts on login (per the install). So:
- First login after install → a screen-share dialog pops up unprompted, with no app context explaining why. Confusing and slightly alarming for a privacy tool.
- `PersistMode::ExplicitlyRevoked` + restore token is the *correct* choice for suppressing it afterwards — **on portals that support persistence (GNOME, KDE).**
- **`xdg-desktop-portal-wlr` (Sway) and Hyprland's portal historically do NOT honor restore tokens / persist mode** [needs-hardware]. If so, the picker reappears **every login**, forever. Combined with systemd `Restart=always` (5s), a transient portal failure could even loop the dialog. This must be tested on real Sway/Hyprland.

**→ Tie this to onboarding:** trigger the first `select_sources` from an explicit "Enable capture" button in the first-run wizard, not silently from the background daemon. The user understands the OS dialog when they asked for it.

### 2.2 Multi-monitor: only the first stream is captured [code-confirmed]
`portal.rs:145` — `let node_id = streams[0].pipe_wire_node_id();`. With `multiple=false` the user picks one monitor and only that monitor is ever recorded. A dual-monitor user loses half their screen history **silently** — no warning, no setting. For a "record everything I saw" tool this is a core-promise violation. Note this is also **inconsistent** with the KDE KWin backend, which captures the whole stitched workspace (§4). Either capture all monitors (request `multiple=true`, iterate every returned stream, one PipeWire thread per node) or expose monitor selection in settings — but don't silently drop screens.

### 2.3 DMABuf is not handled — SHM-only assumption [code-confirmed code path; needs-hardware to trigger]
The stream connects with `MAP_BUFFERS` and the process callback reads `data.data()` as a CPU byte slice (`portal.rs:350`), then `convert_spa_to_rgba`. The format params (`build_video_params`, `portal.rs:527`) advertise **no `SPA_FORMAT_VIDEO_modifier`**, i.e. it only asks for linear/SHM buffers. The risk:
- A compliant portal *should* fall back to linear buffers when no modifiers are offered.
- But several portal/compositor combos (notably **Mutter/GNOME with GPU acceleration**) prefer/deliver **DMABuf** buffers. For a DMABuf buffer, `data.data()` typically yields `None` → the callback returns early → `ready` is never set → frames never arrive.
- Symptom: the 5s "no frames received" warning (§2.4) followed by permanent `no frame available yet`. **Capture appears alive but records nothing.**

This is the most important thing to verify on real GNOME hardware. Robust fix: advertise two `EnumFormat` blocks (one with DMABuf modifiers + EGL import path, one SHM fallback), or at minimum detect the DMABuf case and log/surface it loudly instead of silently yielding no frames.

### 2.4 Capture reports success even when zero frames flow [code-confirmed]
`setup_portal_session` waits up to 5s for the first frame; if none arrive it logs `warn!` and **returns `Ok(())` anyway** (`portal.rs:182`). So `initialize()` succeeds, `CaptureManager` is built, the daemon/UI report "capturing" (green), and the screenshot count just… stays at zero. This is the canonical silent failure. **There is no "frames are actually flowing" health signal exposed over D-Bus to the UI.** Every other failure in this section (§2.1 picker dismissed/denied, §2.3 DMABuf, §6 env) terminates here as a green light over a dead pipe.

**Fix:** track `last_frame_at` in shared state; expose it over D-Bus; the UI shows "capturing" only if a frame arrived recently, otherwise "capture stalled — [why]".

### 2.5 Delivered frame is up to one interval stale [code-confirmed]
The process callback only stores a frame when the slot is empty (`needs_frame = frame.is_none()`, `portal.rs:323`). Sequence: consumer takes frame at T → slot empties → next PipeWire callback stores a frame at ~T → that frame then *sits* until the next `capture_frame` at T+interval. So the pixels delivered at T+5s were captured at ~T (≈5s old), while the timestamp is stamped at take-time T+5s (`portal.rs:221`). Result: **content and timestamp are misaligned by up to one interval**, and you can miss what was actually on screen at capture time. Better: dequeue a *fresh* frame on demand at capture time, or at least stamp the timestamp when the frame is stored, not when taken.

### 2.6 `convert_spa_to_rgba` is per-pixel `Vec::push` with per-pixel bounds checks [code-confirmed, perf]
For a 4K screen that's ~33M pushes + bounds checks per frame (`portal.rs:478`). At 1 frame/5s it won't melt anything, but for a tool whose pitch includes "light footprint while running all day," a row-wise `copy_from_slice` / chunked conversion is easy and much cheaper. Minor, but it's in the hot path.

### 2.7 Limited format coverage [code-confirmed]
Only `BGRx/RGBx/BGRA/RGBA` are parsed; anything else falls through to "assume BGRx" (`portal.rs:513`), which would produce wrong colors (and thus garbage OCR) rather than an error. Most portals deliver BGRx so this is usually fine, but an unexpected format degrades silently to bad data instead of a clear failure.

---

## 3. Active-window detection — the GNOME privacy hole [code-confirmed]

Window attribution drives three things: per-app History/Dashboard, **and the two privacy mechanisms** — `excluded_apps` (keepassxc, 1password, bitwarden, …) matched on app/class, and `excluded_title_patterns` ("Incognito", "Private Browsing", "Lock Screen") matched on title. `is_excluded` (`window_info/mod.rs:100`) compares the captured window's `app_name`/`window_title` against those lists.

Provider selection (`detect.rs:173`):
- **KDE** → KWin script (good). **Hyprland/Sway/COSMIC** → `wlr-foreign-toplevel` (good, if the protocol is present).
- **GNOME Wayland** → tries `Window Calls Extended` extension → GNOME Shell `Eval` (disabled by default since GNOME 41) → **`NoopWindowInfo`**.

**Finding 3.1 — On default GNOME, the provider is Noop, so every frame has `app_name = None` and `window_title = None`.** Walk that through `is_excluded`:
- Excluded-app check compares `None` against "keepassxc" etc. → never matches → **password managers are captured and OCR'd.**
- Title-pattern check sees `None` → never matches "Incognito"/"Private Browsing" → **incognito/private windows are captured.**
- Same for "Lock Screen" → see §5.

So on a stock GNOME install (no extra extension), **RewindOS fails open on every privacy guarantee it advertises**, and the user has no idea. Mutter exposes no window title on Wayland by design (privacy), there's no `wlr-foreign-toplevel`, and `Eval` is off — so the *only* path is a third-party extension the user must find and install. The branch name `feat/gnome-window-tracking` suggests this is known and in progress; treat it as a **release blocker for the privacy claim**, not a feature enhancement.

**Minimum fix:** if the window provider resolves to Noop *and* any privacy exclusions are configured, the daemon must surface a prominent warning to the UI ("Window tracking unavailable on this setup — app/incognito exclusions are NOT being enforced. Install the Window Calls Extended extension."), and ideally let the user choose to **pause capture rather than capture unfiltered**. Failing open silently is the one thing a privacy tool must never do.

**Finding 3.2 — KWin window-info writes a script to a fixed `/tmp` path** (`window_info/kwin.rs`, `/tmp/rewindos-kwin-active-window.js`) [code-confirmed, minor]. Predictable `/tmp` path is a mild multi-user/symlink hygiene issue; prefer `$XDG_RUNTIME_DIR`.

---

## 4. KDE Plasma path

Generally the healthiest path: KWin `ScreenShot2` for capture + KWin scripting for window info, both probed before use, portal/wlr fallbacks behind them.

**Finding 4.1 — Inconsistent multi-monitor semantics [code-confirmed].** `CaptureWorkspace` (`capture/kwin.rs:52`) captures the **entire stitched workspace (all monitors)**, whereas the portal path captures **one monitor** (§2.2). Two users on two desktops get materially different products. Pick one model and make both backends honor it.

**Finding 4.2 — `native-resolution=true` on HiDPI [needs-hardware].** On a 4K/200% setup this returns full native pixels — large images, more storage, slower OCR. Worth confirming the downstream `max_capture_width` downscale actually applies before OCR/storage.

---

## 5. Lock-screen capture [code-confirmed risk]
The portal stream keeps running while the session is locked; the compositor renders the lock screen (and notifications/sensitive content over it), and the portal will hand those frames to RewindOS. The only guard is the `"Lock Screen"` title-pattern exclusion — which requires a working window provider. So on **KDE/wlroots it may be filtered (if the title matches), and on GNOME-Noop it is captured outright (§3).** A privacy tool should explicitly detect session-lock (e.g. via the `org.freedesktop.login1`/`org.gnome.ScreenSaver`/`org.freedesktop.ScreenSaver` `ActiveChanged` signal) and **hard-pause capture while locked**, independent of window titles.

---

## 6. Environment/session propagation [code-confirmed]
`detect_session` keys off `WAYLAND_DISPLAY` / `XDG_SESSION_TYPE` (`detect.rs:109`). The daemon is a systemd user service; if it starts before the graphical session exports these (or the unit doesn't import them), detection can land on `Unknown` → no backend → dead capture. The unit declares `graphical-session.target` and passes the vars, but timing/ordering bugs here surface as exactly the silent "green but no frames" state. Worth an explicit "waited for WAYLAND_DISPLAY" retry/backoff rather than one-shot detection at startup.

---

## Severity-ranked fix list

| # | Finding | Severity | Why |
|---|---|---|---|
| 3.1 | GNOME default → privacy exclusions silently fail; sensitive windows captured | **Blocker** | Breaks the core privacy promise on the most common desktop, silently |
| 2.4 | "Capturing" green light over zero frames; no frame-flow health signal | **Blocker** | Hides every other capture failure from the user |
| 5 | Lock-screen contents can be captured | **Blocker** | Privacy; trivially bad optics |
| 2.3 | DMABuf delivers no frames (SHM-only assumption) | **High** | Likely affects real GNOME GPU setups → records nothing |
| 2.2 | Multi-monitor captures only one screen, silently | **High** | Core-promise violation for a common setup |
| 2.1 | Picker reappears every login on wlr/Hyprland (no persist) | **High** | Daily friction; possible dialog-loop with restart |
| 1.1 | X11 unsupported, log-only message | **Medium** | Excludes a real user segment with no in-app guidance |
| 4.1 | KDE vs portal multi-monitor semantics differ | **Medium** | Inconsistent product across desktops |
| 2.5 | Frame up to one interval stale; timestamp misaligned | **Medium** | Wrong "what was on screen when" — the whole point |
| 2.6/2.7 | Per-pixel conversion cost; silent wrong-color on odd formats | **Low** | Footprint + rare bad-data |
| 3.2 | KWin script in fixed `/tmp` path | **Low** | Hygiene |

---

## Bottom line

The capture architecture is **well-structured** — clean backend trait, probe-before-use, sensible per-DE dispatch, good install hints. That's the hard scaffolding done right. But the **failure modes are silent**, and on GNOME (the most common target) two of them — the privacy hole (§3.1) and the DMABuf risk (§2.3) — hit at once: it may record sensitive windows *and* may record nothing at all, both with a green light.

For the "trustworthy, frictionless, truly-local Linux recall tool" positioning, the order of work is: **(1) never fail open on privacy (§3.1, §5), (2) never show green over a dead pipe (§2.4), (3) actually capture everything the user saw (§2.2, §2.3).** Polish and onboarding come after these, because no wizard survives a tool that silently records your password manager or silently records nothing.
