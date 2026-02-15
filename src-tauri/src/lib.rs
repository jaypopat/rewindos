use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::StreamExt;
use rewindos_core::chat::{
    ChatMessage, ChatRole, ChatStreamChunk, ContextAssembler, IntentCategory, IntentClassifier,
    OllamaChatClient, QueryConfidence, ScreenshotReference, SYSTEM_PROMPT,
};
use rewindos_core::config::AppConfig;
use rewindos_core::db::Database;
use rewindos_core::embedding::OllamaClient as EmbeddingClient;
use rewindos_core::schema::{
    ActiveBlock, ActivityResponse, BoundingBox, CachedDailySummary, SearchFilters, SearchResponse,
    TaskUsageStat,
};
use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tracing::warn;

struct AppState {
    dbus: zbus::Connection,
    db: Mutex<Database>,
    config: Mutex<AppConfig>,
    chat_sessions: Arc<Mutex<HashMap<String, Vec<ChatMessage>>>>,
    embedding_client: Option<EmbeddingClient>,
}

#[derive(Debug, Clone, Serialize)]
struct ScreenshotDetail {
    id: i64,
    timestamp: i64,
    app_name: Option<String>,
    window_title: Option<String>,
    window_class: Option<String>,
    file_path: String,
    width: i32,
    height: i32,
    ocr_text: Option<String>,
    bounding_boxes: Vec<BoundingBox>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DaemonStatusResponse {
    is_capturing: bool,
    frames_captured_today: u64,
    frames_deduplicated_today: u64,
    frames_ocr_pending: u64,
    uptime_seconds: u64,
    disk_usage_bytes: u64,
    last_capture_timestamp: Option<i64>,
}

/// Filters received from the frontend (no `query` field — it's a separate param).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct UiSearchFilters {
    start_time: Option<i64>,
    end_time: Option<i64>,
    app_name: Option<String>,
    limit: i64,
    offset: i64,
}

#[tauri::command]
async fn search(
    state: State<'_, AppState>,
    query: String,
    filters: UiSearchFilters,
) -> Result<SearchResponse, String> {
    let filters_json =
        serde_json::to_string(&filters).map_err(|e| format!("serialize filters: {e}"))?;

    let reply = state
        .dbus
        .call_method(
            Some("com.rewindos.Daemon"),
            "/com/rewindos/Daemon",
            Some("com.rewindos.Daemon"),
            "Search",
            &(query.as_str(), filters_json.as_str()),
        )
        .await
        .map_err(|e| format!("dbus call: {e}"))?;

    let result_json: String = reply
        .body()
        .deserialize()
        .map_err(|e| format!("dbus deserialize: {e}"))?;
    let response: SearchResponse =
        serde_json::from_str(&result_json).map_err(|e| format!("parse response: {e}"))?;

    Ok(response)
}

#[tauri::command]
async fn get_daemon_status(state: State<'_, AppState>) -> Result<DaemonStatusResponse, String> {
    let reply = state
        .dbus
        .call_method(
            Some("com.rewindos.Daemon"),
            "/com/rewindos/Daemon",
            Some("com.rewindos.Daemon"),
            "GetStatus",
            &(),
        )
        .await
        .map_err(|e| format!("dbus call: {e}"))?;

    let status_json: String = reply
        .body()
        .deserialize()
        .map_err(|e| format!("dbus deserialize: {e}"))?;
    let status: DaemonStatusResponse =
        serde_json::from_str(&status_json).map_err(|e| format!("parse status: {e}"))?;

    Ok(status)
}

#[tauri::command]
async fn pause_capture(state: State<'_, AppState>) -> Result<(), String> {
    state
        .dbus
        .call_method(
            Some("com.rewindos.Daemon"),
            "/com/rewindos/Daemon",
            Some("com.rewindos.Daemon"),
            "Pause",
            &(),
        )
        .await
        .map_err(|e| format!("dbus call: {e}"))?;

    Ok(())
}

#[tauri::command]
async fn resume_capture(state: State<'_, AppState>) -> Result<(), String> {
    state
        .dbus
        .call_method(
            Some("com.rewindos.Daemon"),
            "/com/rewindos/Daemon",
            Some("com.rewindos.Daemon"),
            "Resume",
            &(),
        )
        .await
        .map_err(|e| format!("dbus call: {e}"))?;

    Ok(())
}

#[tauri::command]
fn get_screenshot(state: State<'_, AppState>, id: i64) -> Result<ScreenshotDetail, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;

    let screenshot = db
        .get_screenshot(id)
        .map_err(|e| format!("db error: {e}"))?
        .ok_or_else(|| format!("screenshot {id} not found"))?;

    let ocr_text = db
        .get_ocr_text(id)
        .map_err(|e| format!("ocr text error: {e}"))?;

    let bounding_boxes = db
        .get_bounding_boxes(id)
        .map_err(|e| format!("bounding boxes error: {e}"))?;

    Ok(ScreenshotDetail {
        id: screenshot.id,
        timestamp: screenshot.timestamp,
        app_name: screenshot.app_name,
        window_title: screenshot.window_title,
        window_class: screenshot.window_class,
        file_path: screenshot.file_path,
        width: screenshot.width,
        height: screenshot.height,
        ocr_text,
        bounding_boxes,
    })
}

#[derive(Debug, Clone, Serialize)]
struct TimelineEntry {
    id: i64,
    timestamp: i64,
    app_name: Option<String>,
    window_title: Option<String>,
    thumbnail_path: Option<String>,
    file_path: String,
}

#[tauri::command]
fn browse_screenshots(
    state: State<'_, AppState>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    app_name: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<TimelineEntry>, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    let screenshots = db
        .browse_screenshots(
            start_time,
            end_time,
            app_name.as_deref(),
            limit.unwrap_or(200),
            0,
        )
        .map_err(|e| format!("db error: {e}"))?;

    Ok(screenshots
        .into_iter()
        .map(|s| TimelineEntry {
            id: s.id,
            timestamp: s.timestamp,
            app_name: s.app_name,
            window_title: s.window_title,
            thumbnail_path: s.thumbnail_path,
            file_path: s.file_path,
        })
        .collect())
}

#[tauri::command]
fn get_app_names(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.get_app_names().map_err(|e| format!("db error: {e}"))
}

#[tauri::command]
fn get_activity(
    state: State<'_, AppState>,
    since_timestamp: i64,
    until_timestamp: Option<i64>,
) -> Result<ActivityResponse, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.get_activity(since_timestamp, until_timestamp)
        .map_err(|e| format!("db error: {e}"))
}

#[tauri::command]
fn get_task_breakdown(
    state: State<'_, AppState>,
    start_time: i64,
    end_time: i64,
    limit: Option<i64>,
) -> Result<Vec<TaskUsageStat>, String> {
    let capture_interval = state
        .config
        .lock()
        .map_err(|e| format!("config lock: {e}"))?
        .capture
        .interval_seconds as i64;
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.get_task_breakdown(start_time, end_time, limit.unwrap_or(100), capture_interval)
        .map_err(|e| format!("db error: {e}"))
}

#[tauri::command]
fn get_active_blocks(
    state: State<'_, AppState>,
    start_time: i64,
    end_time: i64,
) -> Result<Vec<ActiveBlock>, String> {
    let capture_interval = state
        .config
        .lock()
        .map_err(|e| format!("config lock: {e}"))?
        .capture
        .interval_seconds as i64;
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.get_active_blocks(start_time, end_time, capture_interval)
        .map_err(|e| format!("db error: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DailySummary {
    summary: Option<String>,
    app_breakdown: Vec<AppTimeEntry>,
    total_sessions: usize,
    time_range: String,
    cached: bool,
    generated_at: Option<String>,
    screenshot_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppTimeEntry {
    app_name: String,
    minutes: f64,
    session_count: usize,
}

#[tauri::command]
async fn get_daily_summary(
    state: State<'_, AppState>,
    start_time: i64,
    end_time: i64,
    force_regenerate: Option<bool>,
) -> Result<DailySummary, String> {
    let force = force_regenerate.unwrap_or(false);

    // Compute date_key from start_time
    let date_key = {
        let dt =
            chrono::DateTime::from_timestamp(start_time, 0).unwrap_or_else(|| chrono::Utc::now());
        let local = dt.with_timezone(&chrono::Local);
        local.format("%Y-%m-%d").to_string()
    };

    // Check cache first
    if !force {
        let cached = {
            let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
            db.get_daily_summary_cache(&date_key)
                .map_err(|e| format!("db error: {e}"))?
        };

        if let Some(cached) = cached.filter(|c| c.summary_text.is_some()) {
            // For past days, always use cache. For today, check staleness.
            let now = chrono::Local::now();
            let is_today = date_key == now.format("%Y-%m-%d").to_string();

            let use_cache = if is_today {
                // Check if screenshot count changed significantly (>10% or >5 new)
                let current_count = {
                    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
                    db.get_screenshot_count_in_range(start_time, end_time)
                        .map_err(|e| format!("db error: {e}"))?
                };
                let diff = (current_count - cached.screenshot_count).abs();
                let pct = if cached.screenshot_count > 0 {
                    diff as f64 / cached.screenshot_count as f64
                } else {
                    1.0
                };
                diff <= 5 && pct <= 0.1
            } else {
                true
            };

            if use_cache {
                let app_breakdown: Vec<AppTimeEntry> =
                    serde_json::from_str(&cached.app_breakdown).unwrap_or_default();
                return Ok(DailySummary {
                    summary: cached.summary_text,
                    app_breakdown,
                    total_sessions: cached.total_sessions as usize,
                    time_range: cached.time_range,
                    cached: true,
                    generated_at: Some(cached.generated_at),
                    screenshot_count: cached.screenshot_count,
                });
            }
        }
    }

    // 1. Fetch OCR sessions from DB
    let (sessions, screenshot_count) = {
        let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
        let sessions = db
            .get_ocr_sessions(start_time, end_time, 500)
            .map_err(|e| format!("db error: {e}"))?;
        let count = db
            .get_screenshot_count_in_range(start_time, end_time)
            .map_err(|e| format!("db error: {e}"))?;
        (sessions, count)
    };

    if sessions.is_empty() {
        return Ok(DailySummary {
            summary: None,
            app_breakdown: Vec::new(),
            total_sessions: 0,
            time_range: String::new(),
            cached: false,
            generated_at: None,
            screenshot_count: 0,
        });
    }

    // 2. Build app breakdown from raw session data
    let capture_interval_secs = {
        let cfg = state
            .config
            .lock()
            .map_err(|e| format!("config lock: {e}"))?;
        cfg.capture.interval_seconds as f64
    };

    let mut app_times: HashMap<String, (f64, usize)> = HashMap::new();
    let mut current_app: Option<String> = None;
    let mut last_ts = 0i64;

    for (app_name, _window_title, ts, _ocr) in &sessions {
        let name = app_name.clone().unwrap_or_else(|| "Unknown".to_string());
        let is_same = current_app.as_deref() == Some(&name);
        let gap = ts - last_ts;

        let secs = if is_same && gap < 60 && gap > 0 {
            gap as f64
        } else {
            capture_interval_secs
        };

        let entry = app_times.entry(name.clone()).or_insert((0.0, 0));
        entry.0 += secs;
        if !is_same {
            entry.1 += 1;
        }

        current_app = Some(name);
        last_ts = *ts;
    }

    let mut app_breakdown: Vec<AppTimeEntry> = app_times
        .into_iter()
        .map(|(app_name, (secs, count))| AppTimeEntry {
            app_name,
            minutes: (secs / 60.0 * 10.0).round() / 10.0,
            session_count: count,
        })
        .collect();
    app_breakdown.sort_by(|a, b| b.minutes.partial_cmp(&a.minutes).unwrap());

    let total_sessions = app_breakdown.iter().map(|a| a.session_count).sum();

    // 3. Build prompt for Ollama
    let mut context_lines = Vec::new();
    let mut current_group_app: Option<String> = None;
    let mut group_titles: Vec<String> = Vec::new();
    let mut group_ocr_snippets: Vec<String> = Vec::new();

    for (app_name, window_title, _ts, ocr_text) in &sessions {
        let name = app_name.clone().unwrap_or_else(|| "Unknown".to_string());

        if current_group_app.as_deref() != Some(&name) {
            if let Some(prev_app) = &current_group_app {
                let titles: Vec<&str> = group_titles.iter().take(3).map(|s| s.as_str()).collect();
                let snippet = group_ocr_snippets
                    .join(" ")
                    .chars()
                    .take(200)
                    .collect::<String>();
                context_lines.push(format!(
                    "- {prev_app}: windows [{}], content: \"{}\"",
                    titles.join(", "),
                    snippet,
                ));
            }
            current_group_app = Some(name);
            group_titles.clear();
            group_ocr_snippets.clear();
        }

        if let Some(title) = window_title {
            if !title.is_empty() && !group_titles.contains(title) {
                group_titles.push(title.clone());
            }
        }
        let snippet: String = ocr_text.chars().take(100).collect();
        if !snippet.trim().is_empty() {
            group_ocr_snippets.push(snippet);
        }
    }
    if let Some(prev_app) = &current_group_app {
        let titles: Vec<&str> = group_titles.iter().take(3).map(|s| s.as_str()).collect();
        let snippet = group_ocr_snippets
            .join(" ")
            .chars()
            .take(200)
            .collect::<String>();
        context_lines.push(format!(
            "- {prev_app}: windows [{}], content: \"{}\"",
            titles.join(", "),
            snippet,
        ));
    }

    let app_summary_text = app_breakdown
        .iter()
        .take(8)
        .map(|a| {
            format!(
                "{}: {:.0}min ({} sessions)",
                a.app_name, a.minutes, a.session_count
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    let prompt = format!(
        "You are an AI assistant analyzing a user's desktop activity for the day. \
        Based on the data below, write a brief productivity summary (3-5 sentences). \
        Be specific about what the user was working on based on the window titles and screen content. \
        Mention concrete tasks, not just app names. Be encouraging but honest.\n\n\
        App usage: {app_summary_text}\n\n\
        Activity log:\n{}\n\n\
        Write a concise daily summary. Focus on what was accomplished, not just what apps were used. \
        If you can identify specific tasks (coding, writing, browsing topics), mention them.",
        context_lines.join("\n"),
    );

    // 4. Call Ollama — graceful failure
    let (ollama_url, ollama_model) = {
        let cfg = state
            .config
            .lock()
            .map_err(|e| format!("config lock: {e}"))?;
        (
            format!("{}/api/generate", cfg.chat.ollama_url.trim_end_matches('/')),
            cfg.chat.model.clone(),
        )
    };

    let summary_text: Option<String> = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()
    {
        Ok(client) => {
            match client
                .post(&ollama_url)
                .json(&serde_json::json!({
                    "model": ollama_model,
                    "prompt": prompt,
                    "stream": false,
                    "options": {
                        "temperature": 0.7,
                        "num_predict": 512,
                    }
                }))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<serde_json::Value>().await {
                        Ok(json) => {
                            let raw = json["response"].as_str().unwrap_or("").trim();
                            if raw.is_empty() {
                                None
                            } else {
                                // Strip <think>...</think> blocks
                                let cleaned = if let Some(after) = raw.strip_prefix("<think>") {
                                    after
                                        .find("</think>")
                                        .map(|end| after[end + 8..].trim())
                                        .unwrap_or(raw)
                                        .to_string()
                                } else {
                                    let re =
                                        regex_lite::Regex::new(r"(?s)<think>.*?</think>").unwrap();
                                    re.replace_all(raw, "").trim().to_string()
                                };
                                Some(cleaned)
                            }
                        }
                        Err(e) => {
                            warn!("Failed to parse Ollama response: {e}");
                            None
                        }
                    }
                }
                Ok(resp) => {
                    warn!(
                        "Ollama returned {}: {}",
                        resp.status(),
                        resp.text().await.unwrap_or_default()
                    );
                    None
                }
                Err(e) => {
                    warn!("Ollama request failed: {e}");
                    None
                }
            }
        }
        Err(e) => {
            warn!("Failed to build HTTP client: {e}");
            None
        }
    };

    let generated_at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    // 5. Only cache if Ollama produced a summary — don't persist failures
    if summary_text.is_some() {
        let app_breakdown_json = serde_json::to_string(&app_breakdown).unwrap_or_default();
        let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
        let _ = db.set_daily_summary_cache(&CachedDailySummary {
            date_key: date_key.clone(),
            summary_text: summary_text.clone(),
            app_breakdown: app_breakdown_json,
            total_sessions: total_sessions as i64,
            time_range: format!("{start_time}-{end_time}"),
            model_name: Some(ollama_model),
            generated_at: generated_at.clone(),
            screenshot_count,
        });
    }

    Ok(DailySummary {
        summary: summary_text,
        app_breakdown,
        total_sessions,
        time_range: format!("{start_time}-{end_time}"),
        cached: false,
        generated_at: Some(generated_at),
        screenshot_count,
    })
}

// -- Ask / Chat commands --

#[derive(Debug, Clone, Serialize)]
struct AskResponse {
    session_id: String,
    references: Vec<ScreenshotReference>,
}

#[derive(Debug, Clone, Serialize)]
struct AskTokenPayload {
    session_id: String,
    token: String,
    done: bool,
}

#[derive(Debug, Clone, Serialize)]
struct AskDonePayload {
    session_id: String,
    full_response: String,
}

#[derive(Debug, Clone, Serialize)]
struct AskErrorPayload {
    session_id: String,
    error: String,
}

#[tauri::command]
fn ask_new_session(state: State<'_, AppState>) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let mut sessions = state
        .chat_sessions
        .lock()
        .map_err(|e| format!("lock: {e}"))?;
    sessions.insert(session_id.clone(), Vec::new());
    Ok(session_id)
}

#[tauri::command]
async fn ask_health(state: State<'_, AppState>) -> Result<bool, String> {
    let chat_config = {
        let cfg = state
            .config
            .lock()
            .map_err(|e| format!("config lock: {e}"))?;
        cfg.chat.clone()
    };
    let client = OllamaChatClient::new(&chat_config);
    client.health_check().await.map_err(|e| format!("{e}"))
}

#[tauri::command]
async fn ask(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    message: String,
) -> Result<AskResponse, String> {
    let config = state
        .config
        .lock()
        .map_err(|e| format!("config lock: {e}"))?
        .clone();
    let chat_client = OllamaChatClient::new(&config.chat);

    // 1. Classify intent — LLM-based, with regex fallback if Ollama fails
    let intent = match chat_client.analyze_query(&message).await {
        Ok(intent) => {
            tracing::debug!("LLM classified query: {:?}", intent);
            intent
        }
        Err(e) => {
            tracing::warn!("LLM intent classification failed, falling back to regex: {e}");
            IntentClassifier::classify(&message)
        }
    };

    // 2. Retrieve context from DB with fallback strategy (hybrid search when available)
    let max_context_tokens = config.chat.max_context_tokens;

    let (context, references) = match intent.category {
        IntentCategory::Recall | IntentCategory::General | IntentCategory::AppSpecific => {
            let search_query = if intent.search_terms.is_empty() {
                message.clone()
            } else {
                intent.search_terms.join(" ")
            };

            let filters = SearchFilters {
                query: search_query.clone(),
                start_time: intent.time_range.map(|(s, _)| s),
                end_time: intent.time_range.map(|(_, e)| e),
                app_name: intent.app_filter.clone(),
                limit: 15,
                offset: 0,
            };

            // Layer 1: Try hybrid search if embedding client is available
            let mut search_response = None;
            if let Some(ref embed_client) = state.embedding_client {
                // Must NOT hold db lock across async embed() call
                let embedding = embed_client.embed(&search_query).await.ok().flatten();
                if let Some(ref emb) = embedding {
                    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
                    search_response = db.hybrid_search(&filters, Some(emb)).ok();
                }
            }

            let result_count = search_response
                .as_ref()
                .map(|r| r.results.len())
                .unwrap_or(0);

            // Layer 2: FTS5 exact if hybrid returned < 3 or unavailable
            if result_count < 3 {
                let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
                if let Ok(fts_response) = db.search(&filters) {
                    if fts_response.results.len() > result_count {
                        search_response = Some(fts_response);
                    }
                }
            }

            let result_count = search_response
                .as_ref()
                .map(|r| r.results.len())
                .unwrap_or(0);

            // Layer 3: FTS5 OR query if confidence is Low OR < 3 results and > 1 term
            if (intent.confidence == QueryConfidence::Low || result_count < 3)
                && intent.search_terms.len() > 1
            {
                let or_query = intent.search_terms.join(" OR ");
                let or_filters = SearchFilters {
                    query: or_query,
                    ..filters.clone()
                };
                let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
                if let Ok(or_response) = db.search(&or_filters) {
                    if or_response.results.len() > result_count {
                        search_response = Some(or_response);
                    }
                }
            }

            let has_results = search_response
                .as_ref()
                .map(|r| !r.results.is_empty())
                .unwrap_or(false);

            if has_results {
                let response = search_response.unwrap();
                let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
                let results: Vec<_> = response
                    .results
                    .iter()
                    .map(|r| {
                        let ocr = db.get_ocr_text(r.id).unwrap_or(None).unwrap_or_default();
                        (
                            r.id,
                            r.timestamp,
                            r.app_name.clone(),
                            r.window_title.clone(),
                            r.file_path.clone(),
                            ocr,
                        )
                    })
                    .collect();
                ContextAssembler::from_search_results_budgeted(&results, max_context_tokens)
            } else {
                // Layer 4: Timeline fallback — recent sessions
                let now = chrono::Local::now().timestamp();
                let (start, end) = intent.time_range.unwrap_or((now - 86400, now));
                let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
                let sessions = db
                    .get_ocr_sessions_with_ids(start, end, 80)
                    .unwrap_or_default();
                ContextAssembler::from_sessions_with_refs_budgeted(
                    &sessions,
                    max_context_tokens,
                    20,
                )
            }
        }
        IntentCategory::TimeBased => {
            let (start, end) = intent.time_range.unwrap_or_else(|| {
                let now = chrono::Local::now().timestamp();
                (now - 86400, now)
            });

            let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
            match db.get_ocr_sessions_with_ids(start, end, 80) {
                Ok(sessions) => ContextAssembler::from_sessions_with_refs_budgeted(
                    &sessions,
                    max_context_tokens,
                    20,
                ),
                Err(_) => (
                    "No activity data found for this time range.".to_string(),
                    Vec::new(),
                ),
            }
        }
        IntentCategory::Productivity => {
            let (start, end) = intent.time_range.unwrap_or_else(|| {
                let now = chrono::Local::now().timestamp();
                (now - 86400, now)
            });

            let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
            let stats = db.get_app_usage_stats(start, Some(end)).unwrap_or_default();
            let sessions = db
                .get_ocr_sessions_with_ids(start, end, 80)
                .unwrap_or_default();

            let capture_secs = config.capture.interval_seconds as f64;
            let stat_tuples: Vec<_> = stats
                .iter()
                .map(|s| {
                    let minutes = s.screenshot_count as f64 * capture_secs / 60.0;
                    (s.app_name.clone(), minutes, s.screenshot_count as usize)
                })
                .collect();

            ContextAssembler::from_app_stats(&stat_tuples, &sessions, max_context_tokens)
        }
    };

    // 3. Build messages array with timestamp injection
    let now_str = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let system_message = ChatMessage {
        role: ChatRole::System,
        content: format!(
            "{}\n\nCurrent time: {}\n\n{}",
            SYSTEM_PROMPT, now_str, context
        ),
    };

    let user_message = ChatMessage {
        role: ChatRole::User,
        content: message.clone(),
    };

    // Get history and add user message
    let mut messages = vec![system_message];
    {
        let mut sessions = state
            .chat_sessions
            .lock()
            .map_err(|e| format!("lock: {e}"))?;
        let history = sessions.entry(session_id.clone()).or_default();
        // Trim history to max
        let max = config.chat.max_history_messages;
        if history.len() > max {
            *history = history[history.len() - max..].to_vec();
        }
        messages.extend(history.iter().cloned());
        history.push(user_message.clone());
    }
    messages.push(user_message);

    // 4. Spawn streaming task
    let session_id_clone = session_id.clone();
    let chat_sessions = state.chat_sessions.clone();

    tokio::spawn(async move {
        let client = OllamaChatClient::new(&config.chat);
        let mut stream = std::pin::pin!(client.chat_stream(messages));
        let mut full_response = String::new();

        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(ChatStreamChunk { token, done }) => {
                    full_response.push_str(&token);
                    let _ = app.emit(
                        "ask-token",
                        AskTokenPayload {
                            session_id: session_id_clone.clone(),
                            token,
                            done,
                        },
                    );
                    if done {
                        break;
                    }
                }
                Err(e) => {
                    let _ = app.emit(
                        "ask-error",
                        AskErrorPayload {
                            session_id: session_id_clone.clone(),
                            error: e.to_string(),
                        },
                    );
                    return;
                }
            }
        }

        // Store assistant message in session
        if let Ok(mut sessions) = chat_sessions.lock() {
            if let Some(history) = sessions.get_mut(&session_id_clone) {
                history.push(ChatMessage {
                    role: ChatRole::Assistant,
                    content: full_response.clone(),
                });
            }
        }

        let _ = app.emit(
            "ask-done",
            AskDonePayload {
                session_id: session_id_clone,
                full_response,
            },
        );
    });

    // 5. Return immediately
    Ok(AskResponse {
        session_id,
        references,
    })
}

// -- Delete commands --

#[tauri::command]
async fn delete_screenshots_in_range(
    state: State<'_, AppState>,
    start_time: i64,
    end_time: i64,
) -> Result<u64, String> {
    let reply = state
        .dbus
        .call_method(
            Some("com.rewindos.Daemon"),
            "/com/rewindos/Daemon",
            Some("com.rewindos.Daemon"),
            "DeleteRange",
            &(start_time, end_time),
        )
        .await
        .map_err(|e| format!("dbus call: {e}"))?;

    let deleted: u64 = reply
        .body()
        .deserialize()
        .map_err(|e| format!("dbus deserialize: {e}"))?;

    Ok(deleted)
}

// -- Settings commands --

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cfg = state
        .config
        .lock()
        .map_err(|e| format!("config lock: {e}"))?;
    serde_json::to_value(&*cfg).map_err(|e| format!("serialize: {e}"))
}

#[tauri::command]
fn update_config(state: State<'_, AppState>, config_json: serde_json::Value) -> Result<(), String> {
    let new_config: AppConfig =
        serde_json::from_value(config_json).map_err(|e| format!("invalid config: {e}"))?;

    // Save to disk
    let base_dir = AppConfig::default_base_dir().map_err(|e| format!("{e}"))?;
    let config_path = base_dir.join("config.toml");
    let toml_str =
        toml::to_string_pretty(&new_config).map_err(|e| format!("serialize toml: {e}"))?;
    std::fs::write(&config_path, toml_str).map_err(|e| format!("write config: {e}"))?;

    // Update in-memory config
    let mut cfg = state
        .config
        .lock()
        .map_err(|e| format!("config lock: {e}"))?;
    *cfg = new_config;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let ctrl_shift_space =
                            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
                        if shortcut == &ctrl_shift_space {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                                // Emit event so frontend can focus search input
                                let _ = window.emit("focus-search", ());
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Connect to session D-Bus (blocking, then convert to async)
            let dbus = zbus::blocking::Connection::session()
                .map(|c| c.into_inner())
                .map_err(|e| {
                    warn!("Failed to connect to D-Bus session bus: {e}");
                    Box::new(e) as Box<dyn std::error::Error>
                })?;

            // Open database read-only (WAL mode supports concurrent readers)
            let config = rewindos_core::AppConfig::load()
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            let db_path = config
                .db_path()
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            let db =
                Database::open(&db_path).map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;

            let embedding_client = if config.semantic.enabled {
                Some(EmbeddingClient::new(
                    &config.semantic.ollama_url,
                    &config.semantic.model,
                ))
            } else {
                None
            };

            app.manage(AppState {
                dbus,
                db: Mutex::new(db),
                config: Mutex::new(config),
                chat_sessions: Arc::new(Mutex::new(HashMap::new())),
                embedding_client,
            });

            // Register Ctrl+Shift+Space global shortcut
            let ctrl_shift_space =
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
            if let Err(e) = app.global_shortcut().register(ctrl_shift_space) {
                warn!("Failed to register global shortcut: {e}");
            }

            // System tray
            let toggle_item = MenuItemBuilder::with_id("toggle", "Pause Capture")
                .build(app)
                .expect("failed to build toggle menu item");
            let open_item = MenuItemBuilder::with_id("open", "Open Search")
                .build(app)
                .expect("failed to build open menu item");
            let quit_item = MenuItemBuilder::with_id("quit", "Quit")
                .build(app)
                .expect("failed to build quit menu item");

            let tray_menu = MenuBuilder::new(app)
                .item(&toggle_item)
                .item(&open_item)
                .separator()
                .item(&quit_item)
                .build()
                .expect("failed to build tray menu");

            let tray_icon =
                tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
                    .expect("failed to load tray icon");

            // If launched with --minimized, hide the window (autostart mode)
            let start_minimized = std::env::args().any(|a| a == "--minimized");
            if start_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("RewindOS - Capturing")
                .menu(&tray_menu)
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "toggle" => {
                            // Toggle pause/resume via D-Bus
                            let app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let state = app.state::<AppState>();
                                // Check current status
                                let reply = state
                                    .dbus
                                    .call_method(
                                        Some("com.rewindos.Daemon"),
                                        "/com/rewindos/Daemon",
                                        Some("com.rewindos.Daemon"),
                                        "GetStatus",
                                        &(),
                                    )
                                    .await;

                                match reply {
                                    Ok(reply) => {
                                        if let Ok(status_json) =
                                            reply.body().deserialize::<String>()
                                        {
                                            if let Ok(status) =
                                                serde_json::from_str::<serde_json::Value>(
                                                    &status_json,
                                                )
                                            {
                                                let is_capturing = status["is_capturing"]
                                                    .as_bool()
                                                    .unwrap_or(true);
                                                let method =
                                                    if is_capturing { "Pause" } else { "Resume" };
                                                let _ = state
                                                    .dbus
                                                    .call_method(
                                                        Some("com.rewindos.Daemon"),
                                                        "/com/rewindos/Daemon",
                                                        Some("com.rewindos.Daemon"),
                                                        method,
                                                        &(),
                                                    )
                                                    .await;
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        warn!("failed to get daemon status for tray toggle: {e}");
                                    }
                                }
                            });
                        }
                        "open" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)
                .expect("failed to build tray icon");

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide to tray on close instead of quitting
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            search,
            get_daemon_status,
            pause_capture,
            resume_capture,
            get_screenshot,
            get_app_names,
            get_activity,
            get_task_breakdown,
            get_active_blocks,
            browse_screenshots,
            get_daily_summary,
            ask,
            ask_new_session,
            ask_health,
            delete_screenshots_in_range,
            get_config,
            update_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
