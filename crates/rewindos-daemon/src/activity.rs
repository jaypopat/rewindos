//! Focused-app time tracker.
//!
//! Samples the active window on a short timer and records it into
//! `app_sessions`, independently of the screenshot pipeline. This is what keeps
//! usage stats working in usage-only (private) mode. Only the resolved app
//! name is stored; the window title is read solely to apply the exclusion list.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rewindos_core::app_label::AppLabelResolver;
use rewindos_core::config::PrivacyConfig;
use rewindos_core::db::Database;
use tracing::warn;

use crate::capture::gate::CaptureGate;
use crate::window_info::{self, SharedProvider};

const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
/// A sample further than this from the previous one starts a new session, so
/// lock, pause, and suspend gaps are never counted as focused time.
const MAX_GAP_SECS: i64 = 15;

/// `daemon_state` key persisting usage-only mode across restarts, so a reboot
/// never silently resumes screenshots during private work.
pub const USAGE_ONLY_KEY: &str = "usage_only";

pub fn load_usage_only(db: &Mutex<Database>) -> bool {
    let db = db.lock().unwrap_or_else(|e| e.into_inner());
    matches!(db.get_daemon_state(USAGE_ONLY_KEY), Ok(Some(v)) if v == "1")
}

pub fn persist_usage_only(db: &Mutex<Database>, enabled: bool) -> rewindos_core::error::Result<()> {
    let db = db.lock().unwrap_or_else(|e| e.into_inner());
    db.set_daemon_state(USAGE_ONLY_KEY, if enabled { "1" } else { "0" })
}

pub fn spawn(
    db: Arc<Mutex<Database>>,
    gate: Arc<CaptureGate>,
    window_info: SharedProvider,
    app_labels: Arc<AppLabelResolver>,
    privacy: PrivacyConfig,
) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SAMPLE_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if !gate.should_track() {
                continue;
            }
            let window = window_info.load_full().current();
            let Some(raw) = window.app_name.as_deref() else {
                continue;
            };
            if window_info::is_excluded(
                &window,
                &privacy.excluded_apps,
                &privacy.excluded_title_patterns,
            ) {
                continue;
            }
            let app = app_labels.resolve(raw);
            let now = chrono::Utc::now().timestamp();
            let db = db.clone();
            let result = tokio::task::spawn_blocking(move || {
                let db = db.lock().unwrap_or_else(|e| e.into_inner());
                db.record_app_activity(&app, now, MAX_GAP_SECS)
            })
            .await;
            match result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => warn!(error = %e, "activity: failed to record app session"),
                Err(e) => warn!(error = %e, "activity: record task panicked"),
            }
        }
    });
}
