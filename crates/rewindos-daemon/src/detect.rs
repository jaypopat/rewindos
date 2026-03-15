use std::env;
use std::sync::Arc;

use tracing::{debug, info, warn};
use zbus::Connection;

use crate::capture::{self, CaptureBackend, CaptureError};
use crate::window_info::gnome_shell::GnomeShellWindowInfo;
use crate::window_info::kwin::KwinWindowInfo;
use crate::window_info::noop::NoopWindowInfo;
use crate::window_info::wlr_foreign_toplevel::WlrForeignToplevelProvider;
use crate::window_info::WindowInfoProvider;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopEnvironment {
    KdePlasma,
    Gnome,
    Hyprland,
    Sway,
    Cosmic,
    X11,
    Unknown,
}

impl std::fmt::Display for DesktopEnvironment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::KdePlasma => write!(f, "KDE Plasma"),
            Self::Gnome => write!(f, "GNOME"),
            Self::Hyprland => write!(f, "Hyprland"),
            Self::Sway => write!(f, "Sway"),
            Self::Cosmic => write!(f, "COSMIC"),
            Self::X11 => write!(f, "X11"),
            Self::Unknown => write!(f, "Unknown"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionType {
    Wayland,
    X11,
    Unknown,
}

impl std::fmt::Display for SessionType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Wayland => write!(f, "Wayland"),
            Self::X11 => write!(f, "X11"),
            Self::Unknown => write!(f, "Unknown"),
        }
    }
}

/// Detect the current desktop environment.
///
/// Detection order:
/// 1. $HYPRLAND_INSTANCE_SIGNATURE → Hyprland
/// 2. $SWAYSOCK → Sway
/// 3. $COSMIC_SESSION_ID or $XDG_CURRENT_DESKTOP contains "COSMIC" → Cosmic
/// 4. $XDG_CURRENT_DESKTOP contains "KDE" → KdePlasma
/// 5. $XDG_CURRENT_DESKTOP contains "GNOME" → Gnome
/// 6. $DISPLAY set (no Wayland indicators) → X11
/// 7. Unknown
pub fn detect_desktop() -> DesktopEnvironment {
    if env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok() {
        debug!("detected Hyprland via $HYPRLAND_INSTANCE_SIGNATURE");
        return DesktopEnvironment::Hyprland;
    }

    if env::var("SWAYSOCK").is_ok() {
        debug!("detected Sway via $SWAYSOCK");
        return DesktopEnvironment::Sway;
    }

    if env::var("COSMIC_SESSION_ID").is_ok() {
        debug!("detected COSMIC via $COSMIC_SESSION_ID");
        return DesktopEnvironment::Cosmic;
    }

    if let Ok(desktop) = env::var("XDG_CURRENT_DESKTOP") {
        let desktop_upper = desktop.to_uppercase();
        if desktop_upper.contains("COSMIC") {
            debug!(desktop = %desktop, "detected COSMIC via $XDG_CURRENT_DESKTOP");
            return DesktopEnvironment::Cosmic;
        }
        if desktop_upper.contains("KDE") {
            debug!(desktop = %desktop, "detected KDE Plasma via $XDG_CURRENT_DESKTOP");
            return DesktopEnvironment::KdePlasma;
        }
        if desktop_upper.contains("GNOME") {
            debug!(desktop = %desktop, "detected GNOME via $XDG_CURRENT_DESKTOP");
            return DesktopEnvironment::Gnome;
        }
    }

    if env::var("DISPLAY").is_ok() && env::var("WAYLAND_DISPLAY").is_err() {
        debug!("detected X11 via $DISPLAY without $WAYLAND_DISPLAY");
        return DesktopEnvironment::X11;
    }

    debug!("could not detect desktop environment");
    DesktopEnvironment::Unknown
}

/// Detect the current session type (Wayland vs X11).
pub fn detect_session() -> SessionType {
    if env::var("WAYLAND_DISPLAY").is_ok() {
        return SessionType::Wayland;
    }

    if let Ok(session_type) = env::var("XDG_SESSION_TYPE") {
        return match session_type.to_lowercase().as_str() {
            "wayland" => SessionType::Wayland,
            "x11" => SessionType::X11,
            _ => SessionType::Unknown,
        };
    }

    if env::var("DISPLAY").is_ok() {
        return SessionType::X11;
    }

    SessionType::Unknown
}

/// Create the appropriate capture backend for the detected environment.
///
/// KDE Plasma tries KWin ScreenShot2 first; if unavailable, falls back to portal.
/// Other Wayland compositors use xdg-desktop-portal + PipeWire.
pub async fn create_capture_backend(
    desktop: &DesktopEnvironment,
    session: &SessionType,
    conn: &Connection,
) -> Result<Box<dyn CaptureBackend>, CaptureError> {
    // KDE Plasma: try KWin ScreenShot2 first, fall back to portal
    if *desktop == DesktopEnvironment::KdePlasma {
        if capture::kwin::is_available(conn).await {
            info!("using KWin ScreenShot2 capture backend (KDE Plasma)");
            return Ok(Box::new(capture::kwin::KwinCaptureBackend::new(
                conn.clone(),
            )));
        }
        warn!("KWin ScreenShot2 unavailable, falling back to xdg-desktop-portal");
    }

    // Wayland: use xdg-desktop-portal + PipeWire
    if *session == SessionType::Wayland || *desktop == DesktopEnvironment::KdePlasma {
        info!("using xdg-desktop-portal + PipeWire capture backend (Wayland session)");
        return Ok(Box::new(capture::portal::PortalCaptureBackend::new()));
    }

    Err(CaptureError::Unavailable(format!(
        "no capture backend available for {desktop:?}/{session:?}"
    )))
}

/// Create the appropriate window info provider for the detected environment.
///
/// Returns the trait object and optionally the KWin-specific reference
/// (needed for D-Bus callback forwarding in the service).
///
/// For GNOME, uses a probe-based fallback chain:
///   wlr-foreign-toplevel (GNOME 45+) → GNOME Shell D-Bus Eval → Noop
///
/// For KDE, uses a probe-based fallback chain:
///   KWin script (primary) → wlr-foreign-toplevel (KWin 6.x) → Noop
///
/// For COSMIC and other Wayland compositors, probes wlr-foreign-toplevel
/// before using it, with Noop fallback.
pub async fn create_window_info_provider(
    desktop: &DesktopEnvironment,
    session: &SessionType,
    conn: &Connection,
) -> (Arc<dyn WindowInfoProvider>, Option<Arc<KwinWindowInfo>>) {
    match desktop {
        DesktopEnvironment::KdePlasma => {
            // Try KWin script first, fall back to wlr-foreign-toplevel, then Noop
            let kwin = Arc::new(KwinWindowInfo::new(conn.clone()));
            if kwin.probe().await {
                info!("using KWin window info provider");
                return (kwin.clone() as Arc<dyn WindowInfoProvider>, Some(kwin));
            }
            warn!("KWin window info probe failed, trying wlr-foreign-toplevel fallback");

            let wlr = WlrForeignToplevelProvider::new();
            if wlr.probe().await {
                info!("KDE: using wlr-foreign-toplevel window info provider (KWin 6.x)");
                return (Arc::new(wlr) as Arc<dyn WindowInfoProvider>, None);
            }

            warn!("KDE: no window info provider available, using noop");
            (
                Arc::new(NoopWindowInfo) as Arc<dyn WindowInfoProvider>,
                None,
            )
        }
        DesktopEnvironment::Gnome if *session == SessionType::Wayland => {
            // Probe-based fallback: wlr-foreign-toplevel → GNOME Shell D-Bus → Noop
            let wlr = WlrForeignToplevelProvider::new();
            if wlr.probe().await {
                info!("GNOME: using wlr-foreign-toplevel window info provider (GNOME 45+)");
                return (Arc::new(wlr) as Arc<dyn WindowInfoProvider>, None);
            }

            let gnome_shell = GnomeShellWindowInfo::new(conn.clone());
            if gnome_shell.probe().await {
                info!("GNOME: using gnome-shell-dbus window info provider");
                return (Arc::new(gnome_shell) as Arc<dyn WindowInfoProvider>, None);
            }

            warn!("GNOME: no window info provider available, using noop");
            (
                Arc::new(NoopWindowInfo) as Arc<dyn WindowInfoProvider>,
                None,
            )
        }
        _ if *session == SessionType::Wayland => {
            // COSMIC, Hyprland, Sway, Unknown — probe wlr-foreign-toplevel first
            let wlr = WlrForeignToplevelProvider::new();
            if wlr.probe().await {
                info!(
                    desktop = ?desktop,
                    "using wlr-foreign-toplevel window info provider"
                );
                return (Arc::new(wlr) as Arc<dyn WindowInfoProvider>, None);
            }

            warn!(
                desktop = ?desktop,
                "wlr-foreign-toplevel not available, using noop window info provider"
            );
            (
                Arc::new(NoopWindowInfo) as Arc<dyn WindowInfoProvider>,
                None,
            )
        }
        _ => {
            warn!(
                desktop = ?desktop,
                session = ?session,
                "no window info provider available, using noop"
            );
            (
                Arc::new(NoopWindowInfo) as Arc<dyn WindowInfoProvider>,
                None,
            )
        }
    }
}

/// Log diagnostic information about the detected environment.
///
/// Helps users understand what was detected and provides DE-specific guidance.
pub fn log_environment_diagnostic(desktop: &DesktopEnvironment, session: &SessionType) {
    info!(
        desktop = %desktop,
        session = %session,
        "detected environment"
    );

    // Log relevant env vars at debug level
    for var in &[
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_TYPE",
        "WAYLAND_DISPLAY",
        "DISPLAY",
        "HYPRLAND_INSTANCE_SIGNATURE",
        "SWAYSOCK",
        "COSMIC_SESSION_ID",
        "DBUS_SESSION_BUS_ADDRESS",
    ] {
        if let Ok(val) = env::var(var) {
            debug!(var = %var, value = %val, "env");
        }
    }

    match desktop {
        DesktopEnvironment::Gnome => {
            info!("GNOME notes: system tray requires gnome-shell-extension-appindicator; \
                   window tracking uses wlr-foreign-toplevel on GNOME 45+ or GNOME Shell Eval on older versions");
        }
        DesktopEnvironment::X11 => {
            warn!("X11 session detected — screen capture is not supported on X11. \
                   RewindOS requires a Wayland session.");
        }
        DesktopEnvironment::Unknown => {
            warn!(
                "could not detect desktop environment — please report this at \
                 https://github.com/jay/rewindos/issues with the following env vars:"
            );
            for var in &[
                "XDG_CURRENT_DESKTOP",
                "XDG_SESSION_TYPE",
                "WAYLAND_DISPLAY",
                "DISPLAY",
            ] {
                match env::var(var) {
                    Ok(val) => warn!("  {var}={val}"),
                    Err(_) => warn!("  {var}=(unset)"),
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Env var manipulation isn't thread-safe — run with --test-threads=1
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Helper to clear all DE-related env vars before each test.
    fn clear_de_env_vars() {
        for var in &[
            "HYPRLAND_INSTANCE_SIGNATURE",
            "SWAYSOCK",
            "COSMIC_SESSION_ID",
            "XDG_CURRENT_DESKTOP",
            "WAYLAND_DISPLAY",
            "XDG_SESSION_TYPE",
            "DISPLAY",
        ] {
            env::remove_var(var);
        }
    }

    #[test]
    fn detect_hyprland() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("HYPRLAND_INSTANCE_SIGNATURE", "abc123");
        assert_eq!(detect_desktop(), DesktopEnvironment::Hyprland);
        clear_de_env_vars();
    }

    #[test]
    fn detect_sway() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("SWAYSOCK", "/run/user/1000/sway-ipc.sock");
        assert_eq!(detect_desktop(), DesktopEnvironment::Sway);
        clear_de_env_vars();
    }

    #[test]
    fn detect_cosmic_via_session_id() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("COSMIC_SESSION_ID", "some-id");
        assert_eq!(detect_desktop(), DesktopEnvironment::Cosmic);
        clear_de_env_vars();
    }

    #[test]
    fn detect_cosmic_via_xdg_current_desktop() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("XDG_CURRENT_DESKTOP", "COSMIC");
        assert_eq!(detect_desktop(), DesktopEnvironment::Cosmic);
        clear_de_env_vars();
    }

    #[test]
    fn detect_kde() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("XDG_CURRENT_DESKTOP", "KDE");
        assert_eq!(detect_desktop(), DesktopEnvironment::KdePlasma);
        clear_de_env_vars();
    }

    #[test]
    fn detect_gnome() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("XDG_CURRENT_DESKTOP", "GNOME");
        assert_eq!(detect_desktop(), DesktopEnvironment::Gnome);
        clear_de_env_vars();
    }

    #[test]
    fn detect_gnome_ubuntu_style() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        // Ubuntu sets XDG_CURRENT_DESKTOP to "ubuntu:GNOME"
        env::set_var("XDG_CURRENT_DESKTOP", "ubuntu:GNOME");
        assert_eq!(detect_desktop(), DesktopEnvironment::Gnome);
        clear_de_env_vars();
    }

    #[test]
    fn detect_x11() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("DISPLAY", ":0");
        assert_eq!(detect_desktop(), DesktopEnvironment::X11);
        clear_de_env_vars();
    }

    #[test]
    fn detect_unknown() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        assert_eq!(detect_desktop(), DesktopEnvironment::Unknown);
        clear_de_env_vars();
    }

    #[test]
    fn hyprland_takes_priority_over_xdg() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("HYPRLAND_INSTANCE_SIGNATURE", "abc");
        env::set_var("XDG_CURRENT_DESKTOP", "KDE");
        assert_eq!(detect_desktop(), DesktopEnvironment::Hyprland);
        clear_de_env_vars();
    }

    #[test]
    fn sway_takes_priority_over_xdg() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("SWAYSOCK", "/run/sway.sock");
        env::set_var("XDG_CURRENT_DESKTOP", "GNOME");
        assert_eq!(detect_desktop(), DesktopEnvironment::Sway);
        clear_de_env_vars();
    }

    #[test]
    fn cosmic_session_id_takes_priority_over_xdg_kde() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("COSMIC_SESSION_ID", "some-id");
        env::set_var("XDG_CURRENT_DESKTOP", "KDE");
        assert_eq!(detect_desktop(), DesktopEnvironment::Cosmic);
        clear_de_env_vars();
    }

    #[test]
    fn detect_session_wayland() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("WAYLAND_DISPLAY", "wayland-0");
        assert_eq!(detect_session(), SessionType::Wayland);
        clear_de_env_vars();
    }

    #[test]
    fn detect_session_x11() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("XDG_SESSION_TYPE", "x11");
        assert_eq!(detect_session(), SessionType::X11);
        clear_de_env_vars();
    }

    #[test]
    fn detect_session_via_xdg_session_type_wayland() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("XDG_SESSION_TYPE", "wayland");
        assert_eq!(detect_session(), SessionType::Wayland);
        clear_de_env_vars();
    }

    #[test]
    fn detect_session_display_fallback() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("DISPLAY", ":0");
        assert_eq!(detect_session(), SessionType::X11);
        clear_de_env_vars();
    }

    #[test]
    fn detect_session_unknown() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        assert_eq!(detect_session(), SessionType::Unknown);
        clear_de_env_vars();
    }

    #[test]
    fn display_names_are_correct() {
        assert_eq!(DesktopEnvironment::KdePlasma.to_string(), "KDE Plasma");
        assert_eq!(DesktopEnvironment::Gnome.to_string(), "GNOME");
        assert_eq!(DesktopEnvironment::Hyprland.to_string(), "Hyprland");
        assert_eq!(DesktopEnvironment::Sway.to_string(), "Sway");
        assert_eq!(DesktopEnvironment::Cosmic.to_string(), "COSMIC");
        assert_eq!(DesktopEnvironment::X11.to_string(), "X11");
        assert_eq!(DesktopEnvironment::Unknown.to_string(), "Unknown");
    }

    // -- log_environment_diagnostic no-panic tests --

    #[test]
    fn diagnostic_kde_wayland_no_panic() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("XDG_CURRENT_DESKTOP", "KDE");
        env::set_var("WAYLAND_DISPLAY", "wayland-0");
        log_environment_diagnostic(&DesktopEnvironment::KdePlasma, &SessionType::Wayland);
        clear_de_env_vars();
    }

    #[test]
    fn diagnostic_gnome_wayland_no_panic() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("XDG_CURRENT_DESKTOP", "GNOME");
        log_environment_diagnostic(&DesktopEnvironment::Gnome, &SessionType::Wayland);
        clear_de_env_vars();
    }

    #[test]
    fn diagnostic_cosmic_no_panic() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("COSMIC_SESSION_ID", "test");
        log_environment_diagnostic(&DesktopEnvironment::Cosmic, &SessionType::Wayland);
        clear_de_env_vars();
    }

    #[test]
    fn diagnostic_hyprland_no_panic() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("HYPRLAND_INSTANCE_SIGNATURE", "test");
        log_environment_diagnostic(&DesktopEnvironment::Hyprland, &SessionType::Wayland);
        clear_de_env_vars();
    }

    #[test]
    fn diagnostic_sway_no_panic() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("SWAYSOCK", "/run/sway.sock");
        log_environment_diagnostic(&DesktopEnvironment::Sway, &SessionType::Wayland);
        clear_de_env_vars();
    }

    #[test]
    fn diagnostic_x11_no_panic() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        env::set_var("DISPLAY", ":0");
        log_environment_diagnostic(&DesktopEnvironment::X11, &SessionType::X11);
        clear_de_env_vars();
    }

    #[test]
    fn diagnostic_unknown_no_panic() {
        let _lock = ENV_LOCK.lock().unwrap();
        clear_de_env_vars();
        log_environment_diagnostic(&DesktopEnvironment::Unknown, &SessionType::Unknown);
        clear_de_env_vars();
    }
}
