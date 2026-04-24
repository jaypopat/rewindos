use rewindos_core::chat::{
    ContextAssembler, IntentCategory, IntentClassifier, OllamaChatClient, QueryConfidence,
    ScreenshotReference,
};
use rewindos_core::config::AppConfig;
use rewindos_core::db::Database;
use rewindos_core::embedding::OllamaClient as EmbeddingClient;
use rewindos_core::schema::SearchFilters;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ChatContext {
    pub context: String,
    pub references: Vec<ScreenshotReference>,
    pub intent_category: String,
}

pub async fn build(
    db: &std::sync::Mutex<Database>,
    embedding_client: Option<&EmbeddingClient>,
    config: &AppConfig,
    query: &str,
) -> Result<ChatContext, String> {
    let chat_client = OllamaChatClient::new(&config.chat);

    let intent = match chat_client.analyze_query(query).await {
        Ok(i) => i,
        Err(_) => IntentClassifier::classify(query),
    };

    let max_context_tokens = config.chat.max_context_tokens;

    let (context, references) = match intent.category {
        IntentCategory::Recall | IntentCategory::General | IntentCategory::AppSpecific => {
            let search_query = if intent.search_terms.is_empty() {
                query.to_string()
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

            let mut search_response = None;
            if let Some(embed_client) = embedding_client {
                let embedding = embed_client.embed(&search_query).await.ok().flatten();
                if let Some(emb) = embedding {
                    let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
                    search_response = db.hybrid_search(&filters, Some(&emb)).ok();
                }
            }

            let result_count = search_response
                .as_ref()
                .map(|r| r.results.len())
                .unwrap_or(0);

            if result_count < 3 {
                let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
                if let Ok(r) = db.search(&filters) {
                    if r.results.len() > result_count {
                        search_response = Some(r);
                    }
                }
            }

            let result_count = search_response
                .as_ref()
                .map(|r| r.results.len())
                .unwrap_or(0);

            if (intent.confidence == QueryConfidence::Low || result_count < 3)
                && intent.search_terms.len() > 1
            {
                let or_filters = SearchFilters {
                    query: intent.search_terms.join(" OR "),
                    ..filters.clone()
                };
                let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
                if let Ok(r) = db.search(&or_filters) {
                    if r.results.len() > result_count {
                        search_response = Some(r);
                    }
                }
            }

            let has_results = search_response
                .as_ref()
                .map(|r| !r.results.is_empty())
                .unwrap_or(false);

            if has_results {
                let response = search_response.unwrap();
                let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
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
                let now = chrono::Local::now().timestamp();
                let (start, end) = intent.time_range.unwrap_or((now - 86400, now));
                let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
                let sessions = db.get_ocr_sessions_with_ids(start, end, 80).unwrap_or_default();
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
            let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
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
            let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
            let stats = db.get_app_usage_stats(start, Some(end)).unwrap_or_default();
            let sessions = db.get_ocr_sessions_with_ids(start, end, 80).unwrap_or_default();
            let secs = config.capture.interval_seconds as f64;
            let stat_tuples: Vec<_> = stats
                .iter()
                .map(|s| {
                    (
                        s.app_name.clone(),
                        s.screenshot_count as f64 * secs / 60.0,
                        s.screenshot_count as usize,
                    )
                })
                .collect();
            ContextAssembler::from_app_stats(&stat_tuples, &sessions, max_context_tokens)
        }
    };

    let intent_category = match intent.category {
        IntentCategory::Recall => "recall",
        IntentCategory::TimeBased => "time_based",
        IntentCategory::Productivity => "productivity",
        IntentCategory::AppSpecific => "app_specific",
        IntentCategory::General => "general",
    }
    .to_string();

    Ok(ChatContext {
        context,
        references,
        intent_category,
    })
}
