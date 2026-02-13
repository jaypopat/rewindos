use std::env;
use std::sync::Arc;

use tracing::{debug, info, warn};
use zbus::Connection;

use crate::capture::{self, CaptureBackend, CaptureError};
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
    X11,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionType {
    Wayland,
    X11,
    Unknown,
}

/// Detect the current desktop environment.
///
/// Detection order:
/// 1. $HYPRLAND_INSTANCE_SIGNATURE → Hyprland
/// 2. $SWAYSOCK → Sway
/// 3. $XDG_CURRENT_DESKTOP contains "KDE" → KdePlasma
/// 4. $XDG_CURRENT_DESKTOP contains "GNOME" → Gnome
/// 5. $DISPLAY set (no Wayland indicators) → X11
/// 6. Unknown
pub fn detect_desktop() -> DesktopEnvironment {
    if env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok() {
        debug!("detected Hyprland via $HYPRLAND_INSTANCE_SIGNATURE");
        return DesktopEnvironment::Hyprland;
    }

    if env::var("SWAYSOCK").is_ok() {
        debug!("detected Sway via $SWAYSOCK");
        return DesktopEnvironment::Sway;
    }

    if let Ok(desktop) = env::var("XDG_CURRENT_DESKTOP") {
        let desktop_upper = desktop.to_uppercase();
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
/// KDE Plasma always uses KWin ScreenShot2 (silent, no crosshair).
/// Other Wayland compositors use xdg-desktop-portal + PipeWire.
pub fn create_capture_backend(
    desktop: &DesktopEnvironment,
    session: &SessionType,
    conn: &Connection,
) -> Result<Box<dyn CaptureBackend>, CaptureError> {
    // KDE Plasma: always use KWin ScreenShot2 (works on both Wayland and X11, no crosshair)
    if *desktop == DesktopEnvironment::KdePlasma {
        info!("using KWin ScreenShot2 capture backend (KDE Plasma)");
        return Ok(Box::new(capture::kwin::KwinCaptureBackend::new(
            conn.clone(),
        )));
    }

    // Non-KDE Wayland: use xdg-desktop-portal + PipeWire
    if *session == SessionType::Wayland {
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
pub fn create_window_info_provider(
    desktop: &DesktopEnvironment,
    session: &SessionType,
    conn: &Connection,
) -> (Arc<dyn WindowInfoProvider>, Option<Arc<KwinWindowInfo>>) {
    match desktop {
        DesktopEnvironment::KdePlasma => {
            let kwin = Arc::new(KwinWindowInfo::new(conn.clone()));
            info!("using KWin window info provider");
            (kwin.clone() as Arc<dyn WindowInfoProvider>, Some(kwin))
        }
        _ if *session == SessionType::Wayland => {
            info!(
                desktop = ?desktop,
                "using wlr-foreign-toplevel window info provider"
            );
            let provider = Arc::new(WlrForeignToplevelProvider::new());
            (provider as Arc<dyn WindowInfoProvider>, None)
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
