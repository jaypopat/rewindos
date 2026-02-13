use std::sync::Mutex;

use async_trait::async_trait;
use tracing::{debug, info, warn};
use zbus::Connection;

use super::{non_empty, WindowInfo, WindowInfoError, WindowInfoProvider};

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

    async fn load_kwin_script(&self) {
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

        if let Err(e) = std::fs::write(script_path, script_content) {
            warn!(error = %e, "failed to write KWin tracking script");
            return;
        }

        // Unload any previously loaded instance
        let _ = self
            .conn
            .call_method(
                Some("org.kde.KWin"),
                "/Scripting",
                Some("org.kde.kwin.Scripting"),
                "unloadScript",
                &("rewindos-window-tracker",),
            )
            .await;

        // Load the script
        let reply = match self
            .conn
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
        if let Err(e) = self
            .conn
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

    async fn unload_kwin_script(&self) {
        let _ = self
            .conn
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
        self.load_kwin_script().await;
        Ok(())
    }

    fn current(&self) -> WindowInfo {
        self.cached.lock().unwrap().clone()
    }

    async fn stop(&self) -> Result<(), WindowInfoError> {
        self.unload_kwin_script().await;
        Ok(())
    }
}
