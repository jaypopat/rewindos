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

    let search_query = if intent.search_terms.is_empty() {
        query.to_string()
    } else {
        intent.search_terms.join(" ")
    };
    // One embedding shared by screenshot and transcript retrieval.
    let query_embedding = match embedding_client {
        Some(c) => c.embed(&search_query).await.ok().flatten(),
        None => None,
    };

    let (mut context, references) = match intent.category {
        IntentCategory::Recall | IntentCategory::General | IntentCategory::AppSpecific => {
            let filters = SearchFilters {
                query: search_query.clone(),
                start_time: intent.time_range.map(|(s, _)| s),
                end_time: intent.time_range.map(|(_, e)| e),
                app_name: intent.app_filter.clone(),
                limit: 15,
                offset: 0,
            };

            let mut search_response = None;
            if let Some(emb) = &query_embedding {
                let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
                search_response = db.hybrid_search(&filters, Some(emb)).ok();
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
                let sessions = db.get_ocr_sessions_with_ids(start, end, 80, None).unwrap_or_default();
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
            match db.get_ocr_sessions_with_ids(start, end, 80, None) {
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
            let sessions = db.get_ocr_sessions_with_ids(start, end, 80, None).unwrap_or_default();
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

    // Blend in meeting-transcript context: semantic/keyword search for content
    // queries, time-window lookup for time-scoped ones. Best-effort — chat
    // still works if transcript search fails.
    let transcripts = {
        let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
        match intent.category {
            IntentCategory::TimeBased | IntentCategory::Productivity => {
                let (start, end) = intent.time_range.unwrap_or_else(|| {
                    let now = chrono::Local::now().timestamp();
                    (now - 86400, now)
                });
                db.get_transcript_segments_in_range(start, end, 30)
                    .unwrap_or_default()
            }
            _ => db
                .search_transcripts(&search_query, query_embedding.as_deref(), 12)
                .map(|hits| {
                    let mut rows: Vec<_> = hits
                        .iter()
                        .map(|h| {
                            let meeting = db.get_meeting(h.meeting_id).ok().flatten();
                            (
                                h.meeting_id,
                                meeting.as_ref().and_then(|m| m.title.clone()),
                                meeting.map(|m| m.started_at).unwrap_or_default(),
                                h.start_ms,
                                h.speaker_label.clone(),
                                h.text.clone(),
                            )
                        })
                        .collect();
                    // Group by meeting, in conversation order, for readability.
                    rows.sort_by_key(|r| (r.2, r.0, r.3));
                    rows
                })
                .unwrap_or_default(),
        }
    };
    context.push_str(&format_transcripts(&transcripts));

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

/// Render transcript rows `(meeting_id, title, meeting_started_at, start_ms,
/// speaker, text)` as a markdown block, grouped per meeting with [mm:ss]
/// offsets. Empty input renders nothing, so screenshot-only answers are
/// unaffected.
fn format_transcripts(rows: &[(i64, Option<String>, i64, i64, String, String)]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let mut out =
        String::from("\n\n## Meeting transcripts (conversations the user recorded)\n");
    let mut last_meeting = i64::MIN;
    for (meeting_id, title, started_at, start_ms, speaker, text) in rows {
        if *meeting_id != last_meeting {
            let when = chrono::DateTime::from_timestamp(*started_at, 0)
                .map(|dt| {
                    dt.with_timezone(&chrono::Local)
                        .format("%Y-%m-%d %H:%M")
                        .to_string()
                })
                .unwrap_or_default();
            let title = title.as_deref().unwrap_or("Untitled meeting");
            out.push_str(&format!("\n### Meeting \"{title}\" — {when}\n"));
            last_meeting = *meeting_id;
        }
        let mins = start_ms / 60_000;
        let secs = (start_ms / 1_000) % 60;
        let snippet: String = text.chars().take(300).collect();
        out.push_str(&format!("[{mins:02}:{secs:02}] {speaker}: {snippet}\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::format_transcripts;

    #[test]
    fn format_transcripts_groups_by_meeting_and_skips_when_empty() {
        assert_eq!(format_transcripts(&[]), "");

        let rows = vec![
            (
                1,
                Some("Standup".to_string()),
                1_700_000_000,
                5_000,
                "You".to_string(),
                "hello".to_string(),
            ),
            (
                1,
                Some("Standup".to_string()),
                1_700_000_000,
                65_000,
                "Remote".to_string(),
                "hi back".to_string(),
            ),
            (
                2,
                None,
                1_700_100_000,
                0,
                "You".to_string(),
                "next call".to_string(),
            ),
        ];
        let out = format_transcripts(&rows);
        assert_eq!(out.matches("### Meeting").count(), 2, "one header per meeting");
        assert!(out.contains("Meeting \"Standup\""));
        assert!(out.contains("Untitled meeting"));
        assert!(out.contains("[00:05] You: hello"));
        assert!(out.contains("[01:05] Remote: hi back"));
    }
}
