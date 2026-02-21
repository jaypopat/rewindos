use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tracing::{debug, info, warn};
use zbus::Connection;

use super::{non_empty, WindowInfo, WindowInfoError, WindowInfoProvider};

/// GNOME Shell D-Bus window info provider.
///
/// Uses GNOME Shell's built-in `Eval` interface to query the focused window.
/// This is the fallback for GNOME desktops that don't support
/// `wlr-foreign-toplevel-management` (i.e. GNOME < 45).
pub struct GnomeShellWindowInfo {
    cached: Arc<Mutex<WindowInfo>>,
    conn: Connection,
    stop_flag: Arc<AtomicBool>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl GnomeShellWindowInfo {
    pub fn new(conn: Connection) -> Self {
        Self {
            cached: Arc::new(Mutex::new(WindowInfo::default())),
            conn,
            stop_flag: Arc::new(AtomicBool::new(false)),
            task: Mutex::new(None),
        }
    }
}

/// JS snippet evaluated via GNOME Shell's Eval D-Bus method.
/// Returns JSON with the focused window's title and wm_class.
const EVAL_SCRIPT: &str = r#"global.display.focus_window ? JSON.stringify({title: global.display.focus_window.get_title(), wm_class: global.display.focus_window.get_wm_class()}) : "{}""#;

#[async_trait]
impl WindowInfoProvider for GnomeShellWindowInfo {
    fn name(&self) -> &'static str {
        "gnome-shell-dbus"
    }

    async fn probe(&self) -> bool {
        // Actually test Eval, not just Introspect — GNOME 41+ disables Eval
        // by default (development-tools = false). If Eval is locked down,
        // the call succeeds but returns (false, "...").
        match self
            .conn
            .call_method(
                Some("org.gnome.Shell"),
                "/org/gnome/Shell",
                Some("org.gnome.Shell"),
                "Eval",
                &("1",),
            )
            .await
        {
            Ok(reply) => {
                if let Ok((success, _)) = reply.body().deserialize::<(bool, String)>() {
                    if !success {
                        warn!(
                            "GNOME Shell Eval is disabled (development-tools = false). \
                             Window tracking will not work. Enable with: \
                             gsettings set org.gnome.shell development-tools true"
                        );
                    }
                    success
                } else {
                    false
                }
            }
            Err(_) => false,
        }
    }

    async fn start(&self) -> Result<(), WindowInfoError> {
        self.stop_flag.store(false, Ordering::Release);

        let conn = self.conn.clone();
        let cached = self.cached.clone();
        let stop_flag = self.stop_flag.clone();

        let handle = tokio::spawn(async move {
            loop {
                if stop_flag.load(Ordering::Acquire) {
                    break;
                }

                match conn
                    .call_method(
                        Some("org.gnome.Shell"),
                        "/org/gnome/Shell",
                        Some("org.gnome.Shell"),
                        "Eval",
                        &(EVAL_SCRIPT,),
                    )
                    .await
                {
                    Ok(reply) => {
                        if let Ok((success, result)) =
                            reply.body().deserialize::<(bool, String)>()
                        {
                            if success {
                                if let Ok(json) =
                                    serde_json::from_str::<serde_json::Value>(&result)
                                {
                                    let title = json["title"]
                                        .as_str()
                                        .map(|s| s.to_string())
                                        .and_then(non_empty);
                                    let wm_class = json["wm_class"]
                                        .as_str()
                                        .map(|s| s.to_string())
                                        .and_then(non_empty);

                                    let mut info = cached.lock().unwrap();
                                    info.window_title = title;
                                    info.app_name = wm_class.clone();
                                    info.window_class = wm_class;

                                    debug!(
                                        app = ?info.app_name,
                                        title = ?info.window_title,
                                        "active window updated via GNOME Shell Eval"
                                    );
                                }
                            }
                        }
                    }
                    Err(e) => {
                        debug!("GNOME Shell Eval call failed: {e}");
                    }
                }

                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        });

        *self.task.lock().unwrap() = Some(handle);
        info!("GNOME Shell D-Bus window tracking started");
        Ok(())
    }

    fn current(&self) -> WindowInfo {
        self.cached.lock().unwrap().clone()
    }

    async fn stop(&self) -> Result<(), WindowInfoError> {
        self.stop_flag.store(true, Ordering::Release);

        let handle = self.task.lock().unwrap().take();
        if let Some(handle) = handle {
            handle.abort();
            let _ = handle.await;
        }

        info!("GNOME Shell D-Bus window tracking stopped");
        Ok(())
    }
}
