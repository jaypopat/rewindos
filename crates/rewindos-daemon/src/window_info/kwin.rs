use std::sync::Mutex;

use async_trait::async_trait;
use tracing::{debug, info};
use zbus::Connection;

use super::{non_empty, WindowInfo, WindowInfoError, WindowInfoProvider};

const KWIN_SCRIPT_PATH: &str = "/tmp/rewindos-kwin-active-window.js";
const KWIN_SCRIPT_NAME: &str = "rewindos-window-tracker";
const KWIN_SCRIPT: &str = r#"
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

// KWin exposes different names across Plasma releases and distributions.
var activationSignal = workspace.windowActivated || workspace.clientActivated;
if (!activationSignal) {
    throw new Error("KWin exposes no supported window activation signal");
}
activationSignal.connect(reportWindow);

// Report the current active window immediately.
reportWindow(workspace.activeWindow || workspace.activeClient);
"#;

/// KWin-based window tracking via a persistent script that sends
/// D-Bus callbacks on window activation.
pub struct KwinWindowInfo {
    cached: Mutex<WindowInfo>,
    script_id: Mutex<Option<i32>>,
    conn: Connection,
}

impl KwinWindowInfo {
    pub fn new(conn: Connection) -> Self {
        Self {
            cached: Mutex::new(WindowInfo::default()),
            script_id: Mutex::new(None),
            conn,
        }
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

    async fn load_kwin_script(&self) -> Result<(), WindowInfoError> {
        std::fs::write(KWIN_SCRIPT_PATH, KWIN_SCRIPT).map_err(|e| {
            WindowInfoError::Provider(format!("failed to write KWin tracking script: {e}"))
        })?;

        // Unload any previously loaded instance
        let _ = self
            .conn
            .call_method(
                Some("org.kde.KWin"),
                "/Scripting",
                Some("org.kde.kwin.Scripting"),
                "unloadScript",
                &(KWIN_SCRIPT_NAME,),
            )
            .await;

        // Load the script
        let reply = self
            .conn
            .call_method(
                Some("org.kde.KWin"),
                "/Scripting",
                Some("org.kde.kwin.Scripting"),
                "loadScript",
                &(KWIN_SCRIPT_PATH, KWIN_SCRIPT_NAME),
            )
            .await
            .map_err(|e| WindowInfoError::DBus(format!("failed to load KWin script: {e}")))?;

        let script_id: i32 = reply
            .body()
            .deserialize()
            .map_err(|e| WindowInfoError::DBus(format!("failed to parse KWin script ID: {e}")))?;

        // Start all loaded scripts
        self.conn
            .call_method(
                Some("org.kde.KWin"),
                "/Scripting",
                Some("org.kde.kwin.Scripting"),
                "start",
                &(),
            )
            .await
            .map_err(|e| WindowInfoError::DBus(format!("failed to start KWin scripts: {e}")))?;

        let reply = self
            .conn
            .call_method(
                Some("org.kde.KWin"),
                "/Scripting",
                Some("org.kde.kwin.Scripting"),
                "isScriptLoaded",
                &(KWIN_SCRIPT_NAME,),
            )
            .await
            .map_err(|e| {
                WindowInfoError::DBus(format!("failed to verify KWin tracking script: {e}"))
            })?;
        let loaded: bool = reply.body().deserialize().map_err(|e| {
            WindowInfoError::DBus(format!("failed to parse KWin script status: {e}"))
        })?;
        if !loaded {
            return Err(WindowInfoError::Provider(
                "KWin tracking script stopped during startup".to_string(),
            ));
        }

        *self.script_id.lock().unwrap() = Some(script_id);
        info!("KWin window tracking script loaded (id={script_id})");
        Ok(())
    }

    async fn unload_kwin_script(&self) {
        let _ = self
            .conn
            .call_method(
                Some("org.kde.KWin"),
                "/Scripting",
                Some("org.kde.kwin.Scripting"),
                "unloadScript",
                &(KWIN_SCRIPT_NAME,),
            )
            .await;

        *self.script_id.lock().unwrap() = None;
    }
}

#[async_trait]
impl WindowInfoProvider for KwinWindowInfo {
    fn name(&self) -> &'static str {
        "KWin Script"
    }

    async fn probe(&self) -> bool {
        self.conn
            .call_method(
                Some("org.kde.KWin"),
                "/Scripting",
                Some("org.freedesktop.DBus.Introspectable"),
                "Introspect",
                &(),
            )
            .await
            .is_ok()
    }

    async fn start(&self) -> Result<(), WindowInfoError> {
        self.load_kwin_script().await
    }

    fn current(&self) -> WindowInfo {
        self.cached.lock().unwrap().clone()
    }

    async fn stop(&self) -> Result<(), WindowInfoError> {
        self.unload_kwin_script().await;
        Ok(())
    }

    fn provides_reliable_metadata(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::KWIN_SCRIPT;

    #[test]
    fn script_supports_window_api() {
        assert!(KWIN_SCRIPT.contains("workspace.windowActivated"));
    }

    #[test]
    fn script_supports_legacy_client_api() {
        assert!(KWIN_SCRIPT.contains("workspace.clientActivated"));
    }

    #[test]
    fn script_reports_current_window_immediately() {
        assert!(KWIN_SCRIPT.contains("workspace.activeWindow || workspace.activeClient"));
    }
}
