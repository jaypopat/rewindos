use std::sync::{Arc, Mutex};

use tracing::{debug, info, warn};
use zbus::Connection;

/// Metadata about the currently active window.
#[derive(Debug, Clone, Default)]
pub struct WindowInfo {
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub window_class: Option<String>,
}

/// Tracks the active window via a persistent KWin script that sends
/// D-Bus callbacks on window activation.  No interactive picker involved.
pub struct WindowTracker {
    cached: Mutex<WindowInfo>,
    script_id: Mutex<Option<i32>>,
}

impl WindowTracker {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            cached: Mutex::new(WindowInfo::default()),
            script_id: Mutex::new(None),
        })
    }

    /// Read the latest cached active window info.
    pub fn current(&self) -> WindowInfo {
        self.cached.lock().unwrap().clone()
    }

    /// Called by the D-Bus service when the KWin script reports a window activation.
    pub fn update(&self, caption: String, resource_class: String, resource_name: String) {
        let mut cached = self.cached.lock().unwrap();
        cached.window_title = non_empty(caption);
        cached.window_class = non_empty(resource_class);
        cached.app_name = non_empty(resource_name);

        debug!(
            app = ?cached.app_name,
            title = ?cached.window_title,
            "active window updated via KWin script"
        );
    }

    /// Load a persistent KWin script that reports window activations via D-Bus.
    ///
    /// The script connects to `workspace.windowActivated` and calls back to
    /// `com.rewindos.Daemon.ReportActiveWindow` on each activation.
    pub async fn load_kwin_script(&self, conn: &Connection) {
        let script_path = "/tmp/rewindos-kwin-active-window.js";

        let script_content = r#"
var reportWindow = function(client) {
    if (client) {
        callDBus(
            "com.rewindos.Daemon",
            "/com/rewindos/Daemon",
            "com.rewindos.Daemon",
            "ReportActiveWindow",
            client.caption || "",
            client.resourceClass || "",
            client.resourceName || ""
        );
    }
};

workspace.windowActivated.connect(reportWindow);

// Report the current active window immediately
var w = workspace.activeWindow;
if (w) {
    reportWindow(w);
}
"#;

        // Write the script to a temp file
        if let Err(e) = std::fs::write(script_path, script_content) {
            warn!(error = %e, "failed to write KWin tracking script");
            return;
        }

        // Unload any previously loaded instance
        let _ = conn
            .call_method(
                Some("org.kde.KWin"),
                "/Scripting",
                Some("org.kde.kwin.Scripting"),
                "unloadScript",
                &("rewindos-window-tracker",),
            )
            .await;

        // Load the script
        let reply = match conn
            .call_method(
                Some("org.kde.KWin"),
                "/Scripting",
                Some("org.kde.kwin.Scripting"),
                "loadScript",
                &(script_path, "rewindos-window-tracker"),
            )
            .await
        {
            Ok(r) => r,
            Err(e) => {
                warn!(error = %e, "failed to load KWin tracking script");
                return;
            }
        };

        let script_id: i32 = match reply.body().deserialize() {
            Ok(id) => id,
            Err(e) => {
                warn!(error = %e, "failed to parse KWin script ID");
                return;
            }
        };

        *self.script_id.lock().unwrap() = Some(script_id);

        // Start all loaded scripts
        if let Err(e) = conn
            .call_method(
                Some("org.kde.KWin"),
                "/Scripting",
                Some("org.kde.kwin.Scripting"),
                "start",
                &(),
            )
            .await
        {
            warn!(error = %e, "failed to start KWin scripts");
            return;
        }

        info!("KWin window tracking script loaded (id={script_id})");
    }

    /// Unload the KWin tracking script.
    pub async fn unload_kwin_script(&self, conn: &Connection) {
        let _ = conn
            .call_method(
                Some("org.kde.KWin"),
                "/Scripting",
                Some("org.kde.kwin.Scripting"),
                "unloadScript",
                &("rewindos-window-tracker",),
            )
            .await;

        *self.script_id.lock().unwrap() = None;
    }
}

/// Check if the active window should be excluded from capture.
///
/// Matches against `excluded_apps` (by app_name or window_class)
/// and `excluded_title_patterns` (substring match on window_title).
pub fn is_excluded(
    info: &WindowInfo,
    excluded_apps: &[String],
    excluded_title_patterns: &[String],
) -> bool {
    // Check app name / window class against exclusion list
    for excluded in excluded_apps {
        let excluded_lower = excluded.to_lowercase();

        if let Some(ref app) = info.app_name {
            if app.to_lowercase() == excluded_lower {
                debug!(app = %app, "excluding by app_name");
                return true;
            }
        }

        if let Some(ref class) = info.window_class {
            if class.to_lowercase() == excluded_lower {
                debug!(class = %class, "excluding by window_class");
                return true;
            }
        }
    }

    // Check window title against exclusion patterns
    if let Some(ref title) = info.window_title {
        let title_lower = title.to_lowercase();
        for pattern in excluded_title_patterns {
            if title_lower.contains(&pattern.to_lowercase()) {
                debug!(title = %title, pattern = %pattern, "excluding by title pattern");
                return true;
            }
        }
    }

    false
}

fn non_empty(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_info(app: &str, title: &str, class: &str) -> WindowInfo {
        WindowInfo {
            app_name: non_empty(app.to_string()),
            window_title: non_empty(title.to_string()),
            window_class: non_empty(class.to_string()),
        }
    }

    #[test]
    fn is_excluded_should_match_app_name() {
        let info = make_info("keepassxc", "KeePassXC - Passwords", "keepassxc");
        let excluded_apps = vec!["keepassxc".to_string()];

        assert!(is_excluded(&info, &excluded_apps, &[]));
    }

    #[test]
    fn is_excluded_should_be_case_insensitive() {
        let info = make_info("KeePassXC", "Passwords", "KeePassXC");
        let excluded_apps = vec!["keepassxc".to_string()];

        assert!(is_excluded(&info, &excluded_apps, &[]));
    }

    #[test]
    fn is_excluded_should_match_window_class() {
        let info = make_info("firefox", "Some Page", "bitwarden");
        let excluded_apps = vec!["bitwarden".to_string()];

        assert!(is_excluded(&info, &excluded_apps, &[]));
    }

    #[test]
    fn is_excluded_should_match_title_pattern() {
        let info = make_info("firefox", "Gmail - Private Browsing", "Navigator");
        let patterns = vec!["Private Browsing".to_string()];

        assert!(is_excluded(&info, &[], &patterns));
    }

    #[test]
    fn is_excluded_should_match_title_pattern_case_insensitive() {
        let info = make_info("firefox", "Some Page - INCOGNITO", "Navigator");
        let patterns = vec!["incognito".to_string()];

        assert!(is_excluded(&info, &[], &patterns));
    }

    #[test]
    fn is_excluded_should_allow_non_excluded_apps() {
        let info = make_info("firefox", "GitHub - Pull Request", "Navigator");
        let excluded_apps = vec!["keepassxc".to_string(), "bitwarden".to_string()];
        let patterns = vec!["Private Browsing".to_string()];

        assert!(!is_excluded(&info, &excluded_apps, &patterns));
    }

    #[test]
    fn is_excluded_should_handle_empty_window_info() {
        let info = WindowInfo::default();
        let excluded_apps = vec!["keepassxc".to_string()];

        assert!(!is_excluded(&info, &excluded_apps, &[]));
    }
}
