use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tracing::{debug, info};
use zbus::Connection;

use super::{non_empty, WindowInfo, WindowInfoError, WindowInfoProvider};

// Window Calls Extended D-Bus addressing. Verified against an installed copy on
// GNOME 48 (busctl): "Window Calls Extended" exposes its methods at
// /org/gnome/Shell/Extensions/WindowsExt — the bare ".../Windows" path belongs to
// the original "Window Calls" extension and does NOT exist for WCE.
const WC_BUS: &str = "org.gnome.Shell";
const WC_PATH: &str = "/org/gnome/Shell/Extensions/WindowsExt";
const WC_IFACE: &str = "org.gnome.Shell.Extensions.WindowsExt";

/// GNOME window info provider backed by the "Window Calls Extended" extension.
///
/// GNOME/Mutter does not implement `wlr-foreign-toplevel-management`, and
/// GNOME Shell `Eval` is disabled by default, so this extension is the
/// supported way to read the focused window on GNOME Wayland.
pub struct WindowCallsExtProvider {
    cached: Arc<Mutex<WindowInfo>>,
    conn: Connection,
    stop_flag: Arc<AtomicBool>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl WindowCallsExtProvider {
    pub fn new(conn: Connection) -> Self {
        Self {
            cached: Arc::new(Mutex::new(WindowInfo::default())),
            conn,
            stop_flag: Arc::new(AtomicBool::new(false)),
            task: Mutex::new(None),
        }
    }
}

/// Call a no-argument WindowsExt method that returns a single string.
async fn call_str(conn: &Connection, method: &str) -> Option<String> {
    let reply = conn
        .call_method(Some(WC_BUS), WC_PATH, Some(WC_IFACE), method, &())
        .await
        .ok()?;
    reply.body().deserialize::<String>().ok()
}

/// Pure mapping from the extension's (title, class) strings to `WindowInfo`.
fn build_window_info(title: String, class: String) -> WindowInfo {
    let class = non_empty(class);
    WindowInfo {
        app_name: class.clone(),
        window_class: class,
        window_title: non_empty(title),
    }
}

#[async_trait]
impl WindowInfoProvider for WindowCallsExtProvider {
    fn name(&self) -> &'static str {
        "window-calls-ext"
    }

    async fn probe(&self) -> bool {
        // The interface only answers when the extension is installed AND enabled.
        call_str(&self.conn, "FocusClass").await.is_some()
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

                let (title_opt, class_opt) = tokio::join!(
                    call_str(&conn, "FocusTitle"),
                    call_str(&conn, "FocusClass"),
                );
                if let (Some(title), Some(class)) = (title_opt, class_opt) {
                    let info = build_window_info(title, class);
                    debug!(app = ?info.app_name, title = ?info.window_title,
                        "active window updated via Window Calls Extended");
                    *cached.lock().unwrap() = info;
                }

                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        });

        *self.task.lock().unwrap() = Some(handle);
        info!("Window Calls Extended window tracking started");
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
        info!("Window Calls Extended window tracking stopped");
        Ok(())
    }

    fn provides_reliable_metadata(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_window_info_maps_title_and_class() {
        let info = build_window_info("GitHub - Pull Request".into(), "firefox".into());
        assert_eq!(info.app_name.as_deref(), Some("firefox"));
        assert_eq!(info.window_class.as_deref(), Some("firefox"));
        assert_eq!(info.window_title.as_deref(), Some("GitHub - Pull Request"));
    }

    #[test]
    fn build_window_info_empty_strings_become_none() {
        let info = build_window_info(String::new(), String::new());
        assert!(info.app_name.is_none());
        assert!(info.window_title.is_none());
        assert!(info.window_class.is_none());
    }
}
