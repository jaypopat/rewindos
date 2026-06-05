//! After a meeting stops: best-effort backfill of transcript embeddings and an
//! Ollama-generated summary. Both degrade gracefully — if Ollama is unreachable
//! they log and skip, never failing the stop path.

use std::sync::{Arc, Mutex};

use futures_util::{pin_mut, StreamExt};
use rewindos_core::chat::{ChatMessage, ChatRole, OllamaChatClient};
use rewindos_core::config::AppConfig;
use rewindos_core::db::Database;
use rewindos_core::embedding::OllamaClient;
use rewindos_core::schema::TranscriptSegment;
use tracing::{info, warn};

/// Run post-processing for a finished meeting (best-effort).
pub async fn run(db: Arc<Mutex<Database>>, config: Arc<AppConfig>, meeting_id: i64) {
    embed_pending_segments(&db, &config).await;
    if config.meeting.summary_enabled {
        summarize_meeting(&db, &config, meeting_id).await;
    }
}

/// Embed any `pending` transcript segments. Stops at the first sign Ollama is
/// down (so we don't spin) — leftover segments stay `pending` for a later run.
async fn embed_pending_segments(db: &Arc<Mutex<Database>>, config: &AppConfig) {
    let client = OllamaClient::new(&config.semantic.ollama_url, &config.semantic.model);
    loop {
        let batch = {
            let db = db.lock().unwrap_or_else(|e| e.into_inner());
            match db.get_pending_transcript_embeddings(32) {
                Ok(b) => b,
                Err(e) => {
                    warn!(error = %e, "meeting: reading pending embeddings failed");
                    return;
                }
            }
        };
        if batch.is_empty() {
            return;
        }
        for (segment_id, text) in batch {
            match client.embed(&text).await {
                Ok(Some(embedding)) => {
                    let db = db.lock().unwrap_or_else(|e| e.into_inner());
                    if let Err(e) = db.insert_transcript_embedding(segment_id, &embedding) {
                        warn!(error = %e, "meeting: storing transcript embedding failed");
                    }
                }
                Ok(None) => {
                    info!("meeting: Ollama unavailable, deferring transcript embeddings");
                    return;
                }
                Err(e) => {
                    warn!(error = %e, "meeting: embedding a segment failed");
                    return;
                }
            }
        }
    }
}

/// Build the chat prompt that asks for a concise summary + action items.
fn build_summary_prompt(segments: &[TranscriptSegment]) -> Vec<ChatMessage> {
    let mut transcript = String::new();
    for s in segments {
        transcript.push_str(&s.speaker_label);
        transcript.push_str(": ");
        transcript.push_str(&s.text);
        transcript.push('\n');
    }
    vec![
        ChatMessage {
            role: ChatRole::System,
            content: "You are a meeting assistant. Write a concise summary of the \
                      meeting, then a bulleted list of any action items."
                .to_string(),
        },
        ChatMessage {
            role: ChatRole::User,
            content: format!("Summarise this meeting transcript:\n\n{transcript}"),
        },
    ]
}

/// Generate and store a summary (best-effort).
async fn summarize_meeting(db: &Arc<Mutex<Database>>, config: &AppConfig, meeting_id: i64) {
    let segments = {
        let db = db.lock().unwrap_or_else(|e| e.into_inner());
        match db.get_meeting_segments(meeting_id) {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "meeting: loading segments for summary failed");
                return;
            }
        }
    };
    if segments.is_empty() {
        return;
    }
    let messages = build_summary_prompt(&segments);
    let client = OllamaChatClient::new(&config.chat);
    let stream = client.chat_stream(messages);
    pin_mut!(stream);
    let mut summary = String::new();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(c) => {
                summary.push_str(&c.token);
                if c.done {
                    break;
                }
            }
            Err(e) => {
                info!(error = %e, "meeting: summary generation unavailable, skipping");
                return;
            }
        }
    }
    let summary = summary.trim();
    if summary.is_empty() {
        return;
    }
    let db = db.lock().unwrap_or_else(|e| e.into_inner());
    if let Err(e) = db.set_meeting_summary(meeting_id, summary) {
        warn!(error = %e, "meeting: storing summary failed");
    } else {
        info!(meeting_id, "meeting: summary stored");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(label: &str, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: 0,
            meeting_id: 1,
            start_ms: 0,
            end_ms: 0,
            source: "mic".to_string(),
            speaker_label: label.to_string(),
            text: text.to_string(),
        }
    }

    #[test]
    fn build_summary_prompt_includes_labelled_lines() {
        let msgs = build_summary_prompt(&[seg("You", "hi there"), seg("Remote", "hello")]);
        assert_eq!(msgs.len(), 2);
        assert!(matches!(msgs[0].role, ChatRole::System));
        assert!(matches!(msgs[1].role, ChatRole::User));
        assert!(msgs[1].content.contains("You: hi there"));
        assert!(msgs[1].content.contains("Remote: hello"));
    }
}
