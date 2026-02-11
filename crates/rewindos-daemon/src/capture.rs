use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rewindos_core::config::{CaptureConfig, PrivacyConfig};
use rewindos_core::schema::RawFrame;
use tracing::{debug, info, warn};

use crate::kwin_capture;
use crate::window_info::{self, WindowTracker};

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("KWin ScreenShot2 not available: {0}")]
    KWin(String),

    #[error("KWin ScreenShot2 D-Bus interface not found")]
    KWinUnavailable,
}

/// Orchestrates KWin screenshot capture + window info enrichment.
pub struct CaptureManager {
    interval: Duration,
    excluded_apps: Vec<String>,
    excluded_title_patterns: Vec<String>,
    dbus_conn: zbus::Connection,
    is_capturing: Arc<AtomicBool>,
    window_tracker: Arc<WindowTracker>,
}

impl CaptureManager {
    /// Verify KWin ScreenShot2 is available, then return a CaptureManager
    /// ready to deliver frames on a timer.
    pub async fn start(
        config: &CaptureConfig,
        privacy_config: &PrivacyConfig,
        dbus_conn: zbus::Connection,
        is_capturing: Arc<AtomicBool>,
        window_tracker: Arc<WindowTracker>,
    ) -> Result<Self, CaptureError> {
        let interval = Duration::from_secs(config.interval_seconds.into());

        info!(
            interval_secs = config.interval_seconds,
            "starting capture via KWin ScreenShot2"
        );

        if !kwin_capture::is_available(&dbus_conn).await {
            return Err(CaptureError::KWinUnavailable);
        }

        Ok(Self {
            interval,
            excluded_apps: privacy_config.excluded_apps.clone(),
            excluded_title_patterns: privacy_config.excluded_title_patterns.clone(),
            dbus_conn,
            is_capturing,
            window_tracker,
        })
    }

    /// Capture the next frame: sleeps for interval, checks is_capturing,
    /// takes a KWin screenshot, enriches with window info, and filters
    /// through the privacy exclusion list.
    ///
    /// Returns `None` if capturing has been stopped (is_capturing = false
    /// and we've been signalled to shut down).
    pub async fn next_frame(&self) -> Option<RawFrame> {
        loop {
            tokio::time::sleep(self.interval).await;

            // Check if we're paused
            if !self.is_capturing.load(Ordering::SeqCst) {
                debug!("capture paused, waiting...");
                // Sleep briefly and re-check rather than busy-looping
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }

            // Capture workspace screenshot via KWin D-Bus
            let mut frame = match kwin_capture::capture_workspace(&self.dbus_conn).await {
                Ok(frame) => frame,
                Err(e) => {
                    warn!(error = %e, "KWin capture failed, will retry");
                    continue;
                }
            };

            // Read cached active window info (updated by KWin script callback)
            let window = self.window_tracker.current();

            if window_info::is_excluded(
                &window,
                &self.excluded_apps,
                &self.excluded_title_patterns,
            ) {
                debug!(
                    app = ?window.app_name,
                    title = ?window.window_title,
                    "skipping excluded window"
                );
                continue;
            }

            frame.app_name = window.app_name;
            frame.window_title = window.window_title;
            frame.window_class = window.window_class;

            return Some(frame);
        }
    }
}
