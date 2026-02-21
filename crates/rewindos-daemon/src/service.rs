use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rewindos_core::config::AppConfig;
use rewindos_core::db::Database;
use rewindos_core::embedding::OllamaClient;
use rewindos_core::schema::{DaemonStatus, QueueDepths, SearchFilters};
use tracing::{info, warn};
use zbus::interface;

use crate::pipeline::PipelineMetrics;
use crate::window_info::kwin::KwinWindowInfo;

/// D-Bus service object for `com.rewindos.Daemon`.
pub struct DaemonService {
    pub db: Arc<Mutex<Database>>,
    pub config: Arc<AppConfig>,
    pub metrics: Arc<PipelineMetrics>,
    pub is_capturing: Arc<std::sync::atomic::AtomicBool>,
    pub start_time: Instant,
    pub ollama_client: Option<Arc<OllamaClient>>,
    pub kwin_window_info: Option<Arc<KwinWindowInfo>>,
    pub capture_backend_name: String,
    pub window_info_provider_name: String,
    pub desktop_name: String,
    pub session_name: String,
}

/// Lock a mutex, logging a warning if it was poisoned.
fn lock_db(db: &Mutex<Database>) -> std::sync::MutexGuard<'_, Database> {
    db.lock().unwrap_or_else(|e| {
        warn!("database mutex was poisoned, recovering");
        e.into_inner()
    })
}

#[interface(name = "com.rewindos.Daemon")]
impl DaemonService {
    async fn pause(&mut self) -> zbus::fdo::Result<()> {
        if !self.is_capturing.load(Ordering::SeqCst) {
            return Err(zbus::fdo::Error::Failed("not capturing".into()));
        }

        info!("pause requested via D-Bus");
        self.is_capturing.store(false, Ordering::SeqCst);

        Ok(())
    }

    async fn resume(&mut self) -> zbus::fdo::Result<()> {
        if self.is_capturing.load(Ordering::SeqCst) {
            return Err(zbus::fdo::Error::Failed("already capturing".into()));
        }

        info!("resume requested via D-Bus");
        self.is_capturing.store(true, Ordering::SeqCst);

        Ok(())
    }

    async fn get_status(&self) -> zbus::fdo::Result<String> {
        let uptime = self.start_time.elapsed().as_secs();
        let is_capturing = self.is_capturing.load(Ordering::SeqCst);
        let frames_captured_today = self.metrics.frames_captured.load(Ordering::Relaxed);
        let frames_deduplicated_today = self.metrics.frames_deduplicated.load(Ordering::Relaxed);
        let frames_ocr_pending = self.metrics.frames_ocr_pending.load(Ordering::Relaxed);
        let capture_interval = self.config.capture.interval_seconds;

        // Compute disk usage off the async executor
        let screenshots_dir = self.config.screenshots_dir().ok();
        let disk_usage_bytes = tokio::task::spawn_blocking(move || {
            screenshots_dir.map(|dir| dir_size(&dir)).unwrap_or(0)
        })
        .await
        .unwrap_or(0);

        let status = DaemonStatus {
            is_capturing,
            frames_captured_today,
            frames_deduplicated_today,
            frames_ocr_pending,
            queue_depths: QueueDepths {
                capture: 0,
                hash: 0,
                ocr: frames_ocr_pending,
                index: 0,
            },
            uptime_seconds: uptime,
            disk_usage_bytes,
            capture_interval,
            last_capture_timestamp: None,
            capture_backend: Some(self.capture_backend_name.clone()),
            window_info_provider: Some(self.window_info_provider_name.clone()),
            desktop: Some(self.desktop_name.clone()),
            session: Some(self.session_name.clone()),
        };

        serde_json::to_string(&status)
            .map_err(|e| zbus::fdo::Error::Failed(format!("serialize error: {e}")))
    }

    async fn search(&self, query: &str, filters_json: &str) -> zbus::fdo::Result<String> {
        let mut filters: SearchFilters = if filters_json.is_empty() || filters_json == "{}" {
            SearchFilters {
                query: query.to_string(),
                start_time: None,
                end_time: None,
                app_name: None,
                limit: 50,
                offset: 0,
            }
        } else {
            serde_json::from_str(filters_json)
                .map_err(|e| zbus::fdo::Error::InvalidArgs(format!("invalid filters: {e}")))?
        };
        filters.query = query.to_string();

        // Embed the query if Ollama is available
        let query_embedding = if let Some(ref client) = self.ollama_client {
            match client.embed(query).await {
                Ok(emb) => emb,
                Err(e) => {
                    warn!("failed to embed query: {e}");
                    None
                }
            }
        } else {
            None
        };

        let db = self.db.clone();
        let result = tokio::task::spawn_blocking(move || {
            let db = lock_db(&db);
            if query_embedding.is_some() {
                db.hybrid_search(&filters, query_embedding.as_deref())
            } else {
                db.search(&filters)
            }
        })
        .await
        .map_err(|e| zbus::fdo::Error::Failed(format!("search task panicked: {e}")))?
        .map_err(|e| zbus::fdo::Error::Failed(format!("search error: {e}")))?;

        serde_json::to_string(&result)
            .map_err(|e| zbus::fdo::Error::Failed(format!("serialize error: {e}")))
    }

    async fn delete_range(&self, start: i64, end: i64) -> zbus::fdo::Result<u64> {
        info!(start, end, "delete range requested via D-Bus");

        let db = self.db.clone();
        let deleted = tokio::task::spawn_blocking(move || {
            let db = lock_db(&db);
            db.delete_screenshots_in_range(start, end)
        })
        .await
        .map_err(|e| zbus::fdo::Error::Failed(format!("delete task panicked: {e}")))?
        .map_err(|e| zbus::fdo::Error::Failed(format!("delete error: {e}")))?;

        Ok(deleted)
    }

    /// Called by the KWin tracking script when the active window changes.
    /// No-op if a non-KWin window info provider is active.
    async fn report_active_window(&self, caption: &str, resource_class: &str, resource_name: &str) {
        if let Some(ref kwin) = self.kwin_window_info {
            kwin.update(
                caption.to_string(),
                resource_class.to_string(),
                resource_name.to_string(),
            );
        }
    }

    #[zbus(property)]
    fn is_capturing(&self) -> bool {
        self.is_capturing.load(Ordering::SeqCst)
    }

    #[zbus(property)]
    fn capture_interval(&self) -> u32 {
        self.config.capture.interval_seconds
    }
}

/// Walk a directory and sum file sizes.
fn dir_size(path: &std::path::Path) -> u64 {
    std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| {
            let meta = e.metadata().ok();
            if meta.as_ref().map(|m| m.is_dir()).unwrap_or(false) {
                dir_size(&e.path())
            } else {
                meta.map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}
