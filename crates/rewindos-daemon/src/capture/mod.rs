pub mod gate;
pub mod kwin;
pub mod portal;

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use rewindos_core::config::{CaptureConfig, PrivacyConfig};
use rewindos_core::schema::RawFrame;
use tracing::{debug, info, warn};

use crate::capture::gate::{stall_threshold_ms, CaptureGate};
use crate::window_info::{self, SharedProvider};

/// Backoff bounds for stream reconnection attempts.
const INITIAL_RECONNECT_BACKOFF: Duration = Duration::from_secs(2);
const MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(30);

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
    #[allow(dead_code)]
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

    /// Rebuild the capture stream from scratch (e.g. after the compositor paused
    /// or killed it on suspend/lock/monitor-off). Backends that can't go stale
    /// keep the default no-op-unavailable. Implementors must reuse any saved
    /// permission so this never prompts the user.
    async fn reconnect(&mut self) -> Result<(), CaptureError> {
        Err(CaptureError::Unavailable(
            "reconnect not supported by this backend".into(),
        ))
    }

    /// True if the backend has observed its stream die (e.g. an Error/Unconnected
    /// transition) and wants the capture loop to call `reconnect()` promptly,
    /// rather than waiting for the stall timeout. Default: never.
    fn needs_reconnect(&self) -> bool {
        false
    }

    /// Clean up resources.
    #[allow(dead_code)]
    async fn shutdown(&mut self) -> Result<(), CaptureError>;
}

/// Orchestrates screen capture with window info enrichment and privacy filtering.
pub struct CaptureManager {
    backend: Box<dyn CaptureBackend>,
    window_info: SharedProvider,
    interval: Duration,
    excluded_apps: Vec<String>,
    excluded_title_patterns: Vec<String>,
    gate: Arc<CaptureGate>,
    // Watchdog state for stream-stall recovery.
    last_success: Instant,
    last_reconnect: Option<Instant>,
    reconnect_backoff: Duration,
}

impl CaptureManager {
    pub async fn start(
        config: &CaptureConfig,
        privacy_config: &PrivacyConfig,
        mut backend: Box<dyn CaptureBackend>,
        window_info: SharedProvider,
        gate: Arc<CaptureGate>,
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
            gate,
            last_success: Instant::now(),
            last_reconnect: None,
            reconnect_backoff: INITIAL_RECONNECT_BACKOFF,
        })
    }

    /// Rebuild the capture stream. `force` bypasses the backoff wait (for
    /// event-driven triggers like resume); otherwise exponential backoff keeps a
    /// permanently-dead stream from being hammered. A genuine frame resets the
    /// backoff (see `next_frame`).
    async fn attempt_reconnect(&mut self, force: bool, reason: &str) {
        if !force {
            if let Some(last) = self.last_reconnect {
                if last.elapsed() < self.reconnect_backoff {
                    return; // too soon since the last attempt
                }
            }
        }
        self.last_reconnect = Some(Instant::now());
        warn!(reason, backend = self.backend.name(), "rebuilding capture stream");
        match self.backend.reconnect().await {
            Ok(()) => {
                info!("capture stream reconnected");
                // Give the fresh stream a full stall window to start delivering
                // before we'd consider it stalled again.
                self.last_success = Instant::now();
            }
            Err(e) => warn!(error = %e, "capture reconnect failed; will retry"),
        }
        self.reconnect_backoff = (self.reconnect_backoff * 2).min(MAX_RECONNECT_BACKOFF);
    }

    /// Capture the next frame: sleeps for interval, checks is_capturing,
    /// takes a screenshot, enriches with window info, and filters
    /// through the privacy exclusion list.
    pub async fn next_frame(&mut self) -> Option<RawFrame> {
        loop {
            tokio::time::sleep(self.interval).await;

            if !self.gate.should_capture() {
                debug!("capture paused/blocked, waiting...");
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }

            // Proactive recovery: a resume hook asked for a reconnect, or the
            // backend saw its stream die. Rebuild before trying to capture,
            // rather than waiting out the stall timeout.
            if self.gate.take_reconnect_request() || self.backend.needs_reconnect() {
                self.attempt_reconnect(true, "stream signalled dead or session resumed")
                    .await;
            }

            let mut frame = match self.backend.capture_frame().await {
                Ok(frame) => {
                    // Healthy frame — reset the watchdog and backoff.
                    self.last_success = Instant::now();
                    self.reconnect_backoff = INITIAL_RECONNECT_BACKOFF;
                    self.last_reconnect = None;
                    frame
                }
                Err(e) => {
                    // No frame. "not ready yet" and "stream is dead" are
                    // indistinguishable at this layer, so lean on timing: if
                    // nothing has arrived for longer than the stall threshold,
                    // rebuild the stream (with backoff).
                    match &e {
                        CaptureError::PipeWire(_) => {
                            debug!(error = %e, "no frame available, retrying")
                        }
                        _ => warn!(error = %e, "capture failed, will retry"),
                    }
                    let threshold = Duration::from_millis(stall_threshold_ms(
                        self.interval.as_secs() as u32,
                    ));
                    if self.last_success.elapsed() > threshold {
                        self.attempt_reconnect(false, "no frames past stall threshold")
                            .await;
                    }
                    continue;
                }
            };

            let window = self.window_info.load_full().current();

            if window_info::is_excluded(&window, &self.excluded_apps, &self.excluded_title_patterns)
            {
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
