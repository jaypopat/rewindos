use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rewindos_core::config::AppConfig;
use rewindos_core::db::Database;
use rewindos_core::embedding::OllamaClient;
use rewindos_core::schema::{
    CachedDailySummary, DaemonStatus, QueueDepths, SearchFilters, SearchResponse,
};
use rewindos_core::summary::{self, DigestInput};
use rewindos_core::vault::gather::DayMemory;
use rewindos_core::vault::write::write_memory;
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};
use zbus::interface;
use zbus::object_server::SignalEmitter;

use crate::capture::gate::{recompute_privacy_gate, CaptureGate};
use crate::detect::{create_window_info_provider, DesktopEnvironment, SessionType};
use crate::meeting::controller::{MeetingCmd, MeetingState};
use crate::pipeline::PipelineMetrics;
use crate::window_info::kwin::KwinWindowInfo;
use crate::window_info::SharedProvider;
use zbus::Connection;

/// D-Bus service object for `com.rewindos.Daemon`.
pub struct DaemonService {
    pub db: Arc<Mutex<Database>>,
    pub config: Arc<AppConfig>,
    pub metrics: Arc<PipelineMetrics>,
    pub gate: Arc<CaptureGate>,
    pub unfiltered_override: Arc<std::sync::atomic::AtomicBool>,
    pub start_time: Instant,
    pub ollama_client: Option<Arc<OllamaClient>>,
    pub kwin_window_info: Option<Arc<KwinWindowInfo>>,
    pub capture_backend_name: String,
    pub window_info: SharedProvider,
    pub recheck_conn: Connection,
    pub desktop: DesktopEnvironment,
    pub session: SessionType,
    pub desktop_name: String,
    pub session_name: String,
    pub meeting_tx: mpsc::Sender<MeetingCmd>,
    pub meeting_state: Arc<MeetingState>,
    pub mic_monitor: std::sync::Mutex<Option<crate::capture::audio::MicMonitor>>,
    /// Serializes vault exports spawned by `ExportDay`/`ExportRange`. Runs are
    /// idempotent, but overlapping exports would just duplicate work.
    pub export_lock: Arc<tokio::sync::Mutex<()>>,
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
    async fn pause(
        &mut self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        if !self.gate.wants_capture() {
            return Err(zbus::fdo::Error::Failed("not capturing".into()));
        }

        info!("pause requested via D-Bus");
        self.gate.set_wants_capture(false);

        let meeting_active = self.meeting_state.active.load(Ordering::Acquire);
        let _ = emitter.state_changed(false, meeting_active).await;
        Ok(())
    }

    async fn resume(
        &mut self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        if self.gate.wants_capture() {
            return Err(zbus::fdo::Error::Failed("already capturing".into()));
        }

        info!("resume requested via D-Bus");
        self.gate.set_wants_capture(true);

        let meeting_active = self.meeting_state.active.load(Ordering::Acquire);
        let _ = emitter.state_changed(true, meeting_active).await;
        Ok(())
    }

    async fn get_status(&self) -> zbus::fdo::Result<String> {
        let uptime = self.start_time.elapsed().as_secs();
        let is_capturing = self.gate.wants_capture();
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

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let capture_state = Some(self.gate.capture_state(now_ms, capture_interval).as_str().to_string());
        let seconds_since_last_frame = self.gate.seconds_since_last_frame(now_ms);
        let last_frame = self.gate.last_frame_at();
        let last_capture_timestamp = if last_frame == 0 { None } else { Some(last_frame as i64) };
        let unfiltered_capture = self.unfiltered_override.load(Ordering::SeqCst);

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
            last_capture_timestamp,
            capture_backend: Some(self.capture_backend_name.clone()),
            window_info_provider: Some(self.window_info.load_full().name().to_string()),
            desktop: Some(self.desktop_name.clone()),
            session: Some(self.session_name.clone()),
            capture_state,
            seconds_since_last_frame,
            unfiltered_capture,
            meeting_active: self.meeting_state.active.load(std::sync::atomic::Ordering::Acquire),
            meeting_id: {
                let id = self.meeting_state.meeting_id.load(std::sync::atomic::Ordering::Acquire);
                (id > 0).then_some(id)
            },
            meeting_started_at: {
                let t = self.meeting_state.started_at.load(std::sync::atomic::Ordering::Acquire);
                (t > 0).then_some(t)
            },
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
        // Quote raw user text so FTS5 operators (", (, AND, *) match literally
        // instead of erroring as query syntax. Embedding below still uses the
        // raw `query` — vector search wants natural language, not quoted tokens.
        let fts_query = rewindos_core::db::fts5_quote(query);
        if fts_query.is_empty() {
            let empty = SearchResponse {
                results: Vec::new(),
                total_count: 0,
                search_mode: None,
            };
            return serde_json::to_string(&empty)
                .map_err(|e| zbus::fdo::Error::Failed(format!("serialize error: {e}")));
        }
        filters.query = fts_query;

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

    /// Re-run window-info provider selection and hot-swap the active provider.
    /// Used after the user installs the Window Calls Extended GNOME extension,
    /// so tracking activates without a daemon restart. Returns the new provider
    /// name. Note: KWin callback wiring is established at startup only; recheck
    /// targets the GNOME extension case where no KWin callback is involved.
    async fn recheck_window_info(&mut self) -> zbus::fdo::Result<String> {
        info!("recheck window info requested via D-Bus");

        let (new_provider, _kwin) =
            create_window_info_provider(&self.desktop, &self.session, &self.recheck_conn).await;
        let new_name = new_provider.name().to_string();

        let old = self.window_info.load_full();
        let old_name = old.name();
        if old_name == new_provider.name() {
            return Ok(new_name);
        }

        if let Err(e) = new_provider.start().await {
            return Err(zbus::fdo::Error::Failed(format!(
                "failed to start new provider: {e}"
            )));
        }
        self.window_info
            .store(crate::window_info::into_shared_inner(new_provider));
        let _ = old.stop().await;

        // The provider may have changed reliability (e.g. Noop -> window-calls-ext);
        // re-evaluate the privacy veto so capture un-blocks immediately.
        let p = self.window_info.load_full();
        recompute_privacy_gate(
            &self.gate,
            &**p,
            &self.config.privacy,
            self.unfiltered_override.load(Ordering::SeqCst),
        );

        info!(from = old_name, to = %new_name, "window info provider hot-swapped");
        Ok(new_name)
    }

    /// Toggle the privacy escape hatch: capture even when window metadata can't
    /// enforce exclusions. In-memory (per-session). Recomputes the privacy gate
    /// immediately so the change takes effect without restart.
    async fn set_unfiltered_capture(&mut self, enabled: bool) -> zbus::fdo::Result<()> {
        info!(enabled, "set unfiltered capture via D-Bus");
        self.unfiltered_override.store(enabled, Ordering::SeqCst);
        let p = self.window_info.load_full();
        recompute_privacy_gate(&self.gate, &**p, &self.config.privacy, enabled);
        Ok(())
    }

    /// Start recording a meeting. Empty `title` means untitled. Returns the new
    /// meeting id.
    async fn start_meeting(
        &self,
        title: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<i64> {
        let title = if title.is_empty() {
            None
        } else {
            Some(title.to_string())
        };
        // A live preview monitor holds its own pw-cat on the mic; leaving it
        // running would contend with capture for the device (and leak the
        // process past the meeting). Stop it before recording starts.
        let prev_monitor = self.mic_monitor.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(p) = prev_monitor {
            tokio::task::spawn_blocking(move || p.stop());
        }
        let (reply_tx, reply_rx) = oneshot::channel();
        self.meeting_tx
            .send(MeetingCmd::Start { title, reply: reply_tx })
            .await
            .map_err(|_| zbus::fdo::Error::Failed("meeting controller unavailable".into()))?;
        let id = reply_rx
            .await
            .map_err(|_| zbus::fdo::Error::Failed("no reply from meeting controller".into()))?
            .map_err(zbus::fdo::Error::Failed)?;
        let _ = emitter.state_changed(self.gate.wants_capture(), true).await;
        Ok(id)
    }

    /// Stop the active meeting (finalize audio, transcript, and post-processing).
    async fn stop_meeting(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.meeting_tx
            .send(MeetingCmd::Stop { reply: reply_tx })
            .await
            .map_err(|_| zbus::fdo::Error::Failed("meeting controller unavailable".into()))?;
        reply_rx
            .await
            .map_err(|_| zbus::fdo::Error::Failed("no reply from meeting controller".into()))?
            .map_err(zbus::fdo::Error::Failed)?;
        let _ = emitter.state_changed(self.gate.wants_capture(), false).await;
        Ok(())
    }

    /// Emitted whenever capture state or meeting-recording state changes, so
    /// clients (e.g. the tray indicator) can react without polling `GetStatus`.
    #[zbus(signal)]
    async fn state_changed(
        emitter: &SignalEmitter<'_>,
        is_capturing: bool,
        meeting_active: bool,
    ) -> zbus::Result<()>;

    /// List available microphone sources (JSON array of {id,name,description}).
    async fn list_audio_sources(&self) -> zbus::fdo::Result<String> {
        let sources = tokio::task::spawn_blocking(crate::capture::audio::list_audio_sources)
            .await
            .map_err(|e| zbus::fdo::Error::Failed(format!("enum task panicked: {e}")))?
            .map_err(|e| zbus::fdo::Error::Failed(format!("enum sources: {e}")))?;
        serde_json::to_string(&sources)
            .map_err(|e| zbus::fdo::Error::Failed(format!("serialize sources: {e}")))
    }

    /// Start the live mic-level monitor on `source` (empty = system default).
    async fn start_mic_monitor(&self, source: &str) -> zbus::fdo::Result<()> {
        let sel = if source.is_empty() { None } else { Some(source.to_string()) };
        let monitor = tokio::task::spawn_blocking(move || crate::capture::audio::MicMonitor::start(sel))
            .await
            .map_err(|e| zbus::fdo::Error::Failed(format!("monitor task panicked: {e}")))?
            .map_err(|e| zbus::fdo::Error::Failed(format!("start monitor: {e}")))?;
        // Replace any previous monitor (stop it first).
        let prev = self.mic_monitor.lock().unwrap_or_else(|e| e.into_inner()).replace(monitor);
        if let Some(p) = prev {
            tokio::task::spawn_blocking(move || p.stop());
        }
        Ok(())
    }

    /// Stop the live mic-level monitor.
    async fn stop_mic_monitor(&self) -> zbus::fdo::Result<()> {
        let prev = self.mic_monitor.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(p) = prev {
            tokio::task::spawn_blocking(move || p.stop());
        }
        Ok(())
    }

    /// Current mic RMS level (0.0 if no monitor running).
    async fn get_mic_level(&self) -> zbus::fdo::Result<f64> {
        let lvl = self
            .mic_monitor
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|m| m.level())
            .unwrap_or(0.0);
        Ok(lvl as f64)
    }

    /// Render + write one day's vault companion note. `date` is "YYYY-MM-DD"
    /// (local). Returns when the export is STARTED, not finished: the export
    /// (which may wait ~minutes on an LLM recap) runs in a background task so
    /// it can't stall the sequential D-Bus dispatcher.
    async fn export_day(&self, date: &str) -> zbus::fdo::Result<()> {
        info!(date, "vault export day requested via D-Bus");
        // Validate eagerly so garbage input still errors at the call site.
        local_day_bounds(date)
            .map_err(|e| zbus::fdo::Error::Failed(format!("export {date}: {e:#}")))?;
        check_export_ready(&self.config)?;

        let db = self.db.clone();
        let config = self.config.clone();
        let lock = self.export_lock.clone();
        let date = date.to_string();
        tokio::spawn(async move {
            let _guard = lock.lock().await;
            match run_export(&db, &config, &date).await {
                Ok(()) => info!(%date, "vault export finished"),
                Err(e) => warn!(%date, "vault export failed: {e:#}"),
            }
        });
        Ok(())
    }

    /// Render + write each day in [start_date, end_date] inclusive (local
    /// dates). Returns when the backfill is STARTED, not finished: the days
    /// are processed sequentially in a background task, and per-day failures
    /// are logged without aborting the rest of the range.
    async fn export_range(&self, start_date: &str, end_date: &str) -> zbus::fdo::Result<()> {
        info!(start_date, end_date, "vault export range requested via D-Bus");
        let dates = dates_inclusive(start_date, end_date);
        if dates.is_empty() {
            return Err(zbus::fdo::Error::Failed("invalid date range".into()));
        }
        if dates.len() > 366 {
            return Err(zbus::fdo::Error::Failed(
                "range too large (max 366 days)".into(),
            ));
        }
        check_export_ready(&self.config)?;

        let db = self.db.clone();
        let config = self.config.clone();
        let lock = self.export_lock.clone();
        tokio::spawn(async move {
            let _guard = lock.lock().await;
            let total = dates.len();
            let mut failed = 0usize;
            for date in dates {
                if let Err(e) = run_export(&db, &config, &date).await {
                    failed += 1;
                    warn!(%date, "vault export failed: {e:#}");
                }
            }
            info!(total, failed, "vault export range finished");
        });
        Ok(())
    }

    #[zbus(property)]
    fn is_capturing(&self) -> bool {
        self.gate.wants_capture()
    }

    #[zbus(property)]
    fn capture_interval(&self) -> u32 {
        self.config.capture.interval_seconds
    }
}

/// Precondition check for the "Write now"/backfill D-Bus handlers: reload
/// config from disk (the UI edits config.toml without notifying the daemon,
/// falling back to the startup config if the reload fails) and fail loudly
/// when an export cannot possibly write, so the UI surfaces an honest error
/// instead of the background task silently no-opping.
fn check_export_ready(startup_config: &AppConfig) -> zbus::fdo::Result<()> {
    let cfg = match AppConfig::load() {
        Ok(c) => c.vault_export,
        Err(e) => {
            warn!("config reload failed, using startup config: {e:#}");
            startup_config.vault_export.clone()
        }
    };
    if !cfg.enabled {
        return Err(zbus::fdo::Error::Failed(
            "vault export is disabled in settings".into(),
        ));
    }
    if cfg.vault_path.is_empty() {
        return Err(zbus::fdo::Error::Failed("vault path not set".into()));
    }
    if !std::path::Path::new(&cfg.vault_path).is_dir() {
        return Err(zbus::fdo::Error::Failed(format!(
            "vault path does not exist: {}",
            cfg.vault_path
        )));
    }
    Ok(())
}

/// Run a full export of `date`: fresh config from disk, gather (blocking),
/// three-tier recap (cached → AI → digest), cache AI recaps, write.
///
/// Reloads config.toml on every call: the UI edits the file without notifying
/// the daemon, so "enable export in Settings → Write now" must work without a
/// daemon restart. Falls back to `startup_config` only if the reload fails.
///
/// Shared by the D-Bus handlers and the end-of-day scheduler.
pub async fn run_export(
    db: &Arc<Mutex<Database>>,
    startup_config: &Arc<AppConfig>,
    date: &str,
) -> anyhow::Result<()> {
    // Fresh config: the UI edits config.toml without notifying us.
    let config = match AppConfig::load() {
        Ok(c) => c,
        Err(e) => {
            warn!("config reload failed, using startup config: {e:#}");
            (**startup_config).clone()
        }
    };
    let cfg = config.vault_export.clone();
    if !cfg.enabled || cfg.vault_path.is_empty() {
        return Ok(());
    }
    let (day_start, day_end) = local_day_bounds(date)?;

    // Gather: blocking DB work off the async thread. Also reads the summary
    // cache and the day's screenshot count while the lock is held.
    let db_clone = db.clone();
    let date_owned = date.to_string();
    let max = cfg.max_moments;
    // Real capture cadence (clamped ≥ 1) so on-screen/app stats aren't skewed
    // for users who changed capture.interval_seconds.
    let capture_interval_secs = (config.capture.interval_seconds as i64).max(1);
    let (mut mem, cached, screenshot_count) = tokio::task::spawn_blocking(move || {
        let db = lock_db(&db_clone);
        let mem = DayMemory::for_date(
            &db,
            &date_owned,
            day_start,
            day_end,
            max,
            capture_interval_secs,
        )?;
        // A whitespace-only cache row is not a usable recap; treat it as
        // absent so the fresh AI recap below still gets cached.
        let cached = db
            .get_daily_summary_cache(&date_owned)
            .ok()
            .flatten()
            .and_then(|c| c.summary_text)
            .filter(|t| !t.trim().is_empty());
        let screenshot_count = db
            .get_screenshot_count_in_range(day_start, day_end)
            .unwrap_or(0);
        anyhow::Ok((mem, cached, screenshot_count))
    })
    .await??;

    if mem.is_empty() {
        return Ok(());
    }

    // Recap only when the "summary" section is enabled: skip the LLM/cache
    // work entirely otherwise (write_memory's section pruning would drop the
    // recap anyway, so generating one would be pure waste).
    if cfg.sections.iter().any(|s| s == "summary") {
        // Three-tier recap: cached AI summary → generate via chat backend → digest.
        let digest = DigestInput {
            on_screen_secs: mem.stats.on_screen_secs,
            peak_hour: mem.stats.peak_hour,
            app_minutes: mem.stats.app_minutes.clone(),
            meeting_count: mem.meetings.len(),
        };
        let prompt = summary::build_daily_prompt_from_memory(&mem);
        let was_cached = cached.is_some();
        let (recap, is_ai) = summary::resolve_recap(cached, &config.chat, &prompt, &digest).await;
        if is_ai && !was_cached {
            // Freshly generated — cache it so the app and re-renders reuse it.
            // Never cache the digest tier: a cached digest would read as a
            // non-upgradeable AI summary. Field shapes mirror the Tauri app's
            // `set_daily_summary_cache` writer (its reader trusts this cache for
            // past days): `app_breakdown` is a JSON array of AppTimeEntry
            // {app_name, minutes, session_count}, `time_range` is "{start}-{end}"
            // unix seconds.
            let app_breakdown = serde_json::to_string(
                &mem.stats
                    .app_minutes
                    .iter()
                    .map(|(app_name, minutes)| {
                        serde_json::json!({
                            "app_name": app_name,
                            "minutes": *minutes as f64,
                            "session_count": 0,
                        })
                    })
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_else(|_| "[]".to_string());
            let entry = CachedDailySummary {
                date_key: date.to_string(),
                summary_text: Some(recap.clone()),
                app_breakdown,
                total_sessions: 0,
                time_range: format!("{day_start}-{day_end}"),
                model_name: Some(config.chat.model.clone()),
                generated_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
                screenshot_count,
            };
            let db_clone = db.clone();
            tokio::task::spawn_blocking(move || {
                let db = lock_db(&db_clone);
                if let Err(e) = db.set_daily_summary_cache(&entry) {
                    warn!("failed to cache daily summary: {e:#}");
                }
            })
            .await?;
        }
        mem.recap = Some(recap);
    }

    let cfg2 = cfg.clone();
    tokio::task::spawn_blocking(move || write_memory(&cfg2, &mem)).await??;
    Ok(())
}

/// Local timestamp of `d`'s midnight. When local midnight does not exist
/// (spring-forward DST gap at 00:00, e.g. America/Santiago), falls back to
/// 01:00; `None` only if both are unrepresentable.
fn local_midnight_ts(d: chrono::NaiveDate) -> Option<i64> {
    use chrono::TimeZone;
    [(0, 0), (1, 0)].into_iter().find_map(|(h, m)| {
        let dt = d.and_hms_opt(h, m, 0)?;
        chrono::Local
            .from_local_datetime(&dt)
            .earliest()
            .map(|t| t.timestamp())
    })
}

/// Local-day `[start, end)` unix-second bounds for a "YYYY-MM-DD" date.
/// `end` is the NEXT day's local midnight (DST-correct day length), falling
/// back to start + 86 400 if that midnight is unrepresentable.
pub fn local_day_bounds(date: &str) -> anyhow::Result<(i64, i64)> {
    let d = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|e| anyhow::anyhow!("invalid date {date:?}: {e}"))?;
    let start = local_midnight_ts(d)
        .ok_or_else(|| anyhow::anyhow!("no local midnight for {date:?}"))?;
    let end = d
        .succ_opt()
        .and_then(local_midnight_ts)
        .unwrap_or(start + 86_400);
    Ok((start, end))
}

/// Inclusive list of "YYYY-MM-DD" between `start` and `end`; empty on parse
/// failure or start > end.
pub fn dates_inclusive(start: &str, end: &str) -> Vec<String> {
    let (Ok(mut d), Ok(e)) = (
        chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d"),
        chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d"),
    ) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while d <= e {
        out.push(d.format("%Y-%m-%d").to_string());
        match d.succ_opt() {
            Some(next) => d = next,
            None => break,
        }
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_inclusive_spans_range() {
        let d = dates_inclusive("2026-06-01", "2026-06-03");
        assert_eq!(d, vec!["2026-06-01", "2026-06-02", "2026-06-03"]);
    }

    #[test]
    fn dates_inclusive_single_day() {
        assert_eq!(dates_inclusive("2026-06-01", "2026-06-01"), vec!["2026-06-01"]);
    }

    #[test]
    fn dates_inclusive_empty_on_garbage() {
        assert!(dates_inclusive("garbage", "2026-06-03").is_empty());
        assert!(dates_inclusive("2026-06-01", "nope").is_empty());
        assert!(dates_inclusive("2026-02-30", "2026-03-01").is_empty());
    }

    #[test]
    fn dates_inclusive_empty_when_start_after_end() {
        assert!(dates_inclusive("2026-06-05", "2026-06-01").is_empty());
    }

    #[test]
    fn local_day_bounds_covers_one_local_day() {
        let (start, end) = local_day_bounds("2026-06-10").unwrap();
        assert!(end > start);
        let len = end - start;
        // 23h–25h tolerance: DST transition days are not 86 400 s long.
        assert!((82_800..=90_000).contains(&len), "day length was {len}s");
    }

    #[test]
    fn local_day_bounds_errors_on_garbage() {
        assert!(local_day_bounds("not-a-date").is_err());
        assert!(local_day_bounds("2026-13-40").is_err());
        assert!(local_day_bounds("").is_err());
    }
}
