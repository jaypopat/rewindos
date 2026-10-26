use std::sync::{Arc, Mutex};
use std::time::Duration;

use rewindos_core::analytics::{Analytics, ChatProvider, CountBucket, Event, Heartbeat, Stamped};
use rewindos_core::config::AppConfig;
use rewindos_core::db::Database;
use rewindos_core::ocr::OcrEngine;
use tracing::debug;

use crate::capture::gate::CaptureGate;

const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const STARTUP_DELAY: Duration = Duration::from_secs(30);

pub fn spawn_heartbeat(
    analytics: Arc<Analytics>,
    db: Arc<Mutex<Database>>,
    gate: Arc<CaptureGate>,
    semantic_available: bool,
) {
    tokio::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        let mut tick = tokio::time::interval(INTERVAL);
        loop {
            tick.tick().await;
            let config = match AppConfig::load() {
                Ok(c) => c,
                Err(e) => {
                    debug!(error = %e, "heartbeat skipped: config unreadable");
                    continue;
                }
            };
            let event = heartbeat(&config, &db, &gate, semantic_available).await;
            analytics.send(vec![Stamped::now(event)]).await;
        }
    });
}

async fn heartbeat(
    config: &AppConfig,
    db: &Arc<Mutex<Database>>,
    gate: &CaptureGate,
    semantic_available: bool,
) -> Event {
    let db = db.clone();
    let screenshots_today = tokio::task::spawn_blocking(move || screenshots_today(&db))
        .await
        .unwrap_or(0);
    Event::DaemonHeartbeat(Heartbeat {
        capture_enabled: config.capture.enabled,
        semantic_enabled: semantic_available,
        chat_enabled: config.chat.enabled,
        chat_provider: ChatProvider::from_config(&config.chat),
        agentic_tools: config.chat.agentic_tools,
        meeting_enabled: config.meeting.enabled,
        vault_export_enabled: config.vault_export.enabled,
        ocr_engine: OcrEngine::from_config(&config.ocr.engine),
        capture_interval_s: config.capture.interval_seconds,
        private_mode: gate.usage_only(),
        screenshots_today_bucket: CountBucket::of(screenshots_today),
    })
}

fn screenshots_today(db: &Mutex<Database>) -> i64 {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let counted = crate::service::local_day_bounds(&today).and_then(|(start, end)| {
        let db = db.lock().unwrap_or_else(|e| e.into_inner());
        Ok(db.get_screenshot_count_in_range(start, end)?)
    });
    counted.unwrap_or_else(|e| {
        debug!(error = %e, "heartbeat: screenshot count failed, reporting 0");
        0
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rewindos_core::analytics::{Endpoint, Source};
    use rewindos_core::schema::NewScreenshot;

    fn db_with_screenshots_today(count: usize) -> Arc<Mutex<Database>> {
        let db = Database::open_in_memory().unwrap();
        let now = chrono::Utc::now();
        for i in 0..count {
            db.insert_screenshot(&NewScreenshot {
                timestamp: now.timestamp(),
                timestamp_ms: now.timestamp_millis() + i as i64,
                app_name: None,
                window_title: None,
                window_class: None,
                file_path: format!("/tmp/{i}.webp"),
                thumbnail_path: None,
                width: 1,
                height: 1,
                file_size_bytes: 1,
                perceptual_hash: vec![0; 8],
            })
            .unwrap();
        }
        Arc::new(Mutex::new(db))
    }

    #[tokio::test]
    async fn heartbeat_reports_config_and_live_state() {
        let mut config = AppConfig::default();
        config.chat.provider = "openrouter".to_string();
        config.chat.agentic_tools = true;
        config.ocr.engine = "paddleocr".to_string();
        config.capture.interval_seconds = 7;
        config.vault_export.enabled = true;
        let gate = CaptureGate::new(true);
        gate.set_usage_only(true);

        let event = heartbeat(&config, &db_with_screenshots_today(3), &gate, true).await;

        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({
                "event": "daemon_heartbeat",
                "capture_enabled": true,
                "semantic_enabled": true,
                "chat_enabled": true,
                "chat_provider": "openrouter",
                "agentic_tools": true,
                "meeting_enabled": false,
                "vault_export_enabled": true,
                "ocr_engine": "paddleocr",
                "capture_interval_s": 7,
                "private_mode": true,
                "screenshots_today_bucket": "1-99",
            })
        );
    }

    #[tokio::test]
    #[ignore = "sends to the compiled-in PostHog endpoint"]
    async fn heartbeat_reaches_the_compiled_endpoint() {
        let endpoint = Endpoint::compiled().expect("build with REWINDOS_POSTHOG_KEY set");
        let dir = tempfile::tempdir().unwrap();
        let analytics = Analytics::new(Source::Daemon, dir.path().to_path_buf(), Some(endpoint));
        let config = AppConfig::default();
        let db = db_with_screenshots_today(120);
        let gate = CaptureGate::new(true);

        for analytics_on in [true, false] {
            let mut on_disk = config.clone();
            on_disk.privacy.analytics = analytics_on;
            on_disk.save_to(&dir.path().join("config.toml")).unwrap();
            let event = heartbeat(&config, &db, &gate, false).await;
            analytics.send(vec![Stamped::now(event)]).await;
        }
    }
}
