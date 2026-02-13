pub mod kwin;
pub mod portal;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use rewindos_core::config::{CaptureConfig, PrivacyConfig};
use rewindos_core::schema::RawFrame;
use tracing::{debug, info, warn};

use crate::window_info::{self, WindowInfoProvider};

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("capture backend unavailable: {0}")]
    Unavailable(String),

    #[error("KWin error: {0}")]
    KWin(String),

    #[error("portal error: {0}")]
    Portal(String),

    #[error("PipeWire error: {0}")]
    PipeWire(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("D-Bus error: {0}")]
    DBus(String),
}

/// Trait for screen capture backends.
#[async_trait]
pub trait CaptureBackend: Send + Sync + 'static {
    /// Human-readable name for logging.
    fn name(&self) -> &'static str;

    /// Initialize the backend (verify availability, set up resources).
    async fn initialize(&mut self) -> Result<(), CaptureError>;

    /// Capture a single frame. Returns raw RGBA pixels.
    async fn capture_frame(&mut self) -> Result<RawFrame, CaptureError>;

    /// Clean up resources.
    async fn shutdown(&mut self) -> Result<(), CaptureError>;
}

/// Orchestrates screen capture with window info enrichment and privacy filtering.
pub struct CaptureManager {
    backend: Box<dyn CaptureBackend>,
    window_info: Arc<dyn WindowInfoProvider>,
    interval: Duration,
    excluded_apps: Vec<String>,
    excluded_title_patterns: Vec<String>,
    is_capturing: Arc<AtomicBool>,
}

impl CaptureManager {
    pub async fn start(
        config: &CaptureConfig,
        privacy_config: &PrivacyConfig,
        mut backend: Box<dyn CaptureBackend>,
        window_info: Arc<dyn WindowInfoProvider>,
        is_capturing: Arc<AtomicBool>,
    ) -> Result<Self, CaptureError> {
        let interval = Duration::from_secs(config.interval_seconds.into());

        info!(
            backend = backend.name(),
            interval_secs = config.interval_seconds,
            "starting capture"
        );

        backend.initialize().await?;

        Ok(Self {
            backend,
            window_info,
            interval,
            excluded_apps: privacy_config.excluded_apps.clone(),
            excluded_title_patterns: privacy_config.excluded_title_patterns.clone(),
            is_capturing,
        })
    }

    /// Capture the next frame: sleeps for interval, checks is_capturing,
    /// takes a screenshot, enriches with window info, and filters
    /// through the privacy exclusion list.
    pub async fn next_frame(&mut self) -> Option<RawFrame> {
        loop {
            tokio::time::sleep(self.interval).await;

            if !self.is_capturing.load(Ordering::SeqCst) {
                debug!("capture paused, waiting...");
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }

            let mut frame = match self.backend.capture_frame().await {
                Ok(frame) => frame,
                Err(e) => {
                    warn!(error = %e, "capture failed, will retry");
                    continue;
                }
            };

            let window = self.window_info.current();

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
