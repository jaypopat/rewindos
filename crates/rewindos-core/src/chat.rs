use crate::config::ChatConfig;
use crate::error::{CoreError, Result};
use futures::StreamExt;
use serde::{Deserialize, Serialize};

// -- Types --

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatStreamChunk {
    pub token: String,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum IntentCategory {
    Recall,
    TimeBased,
    Productivity,
    AppSpecific,
    General,
}

#[derive(Debug, Clone)]
pub struct QueryIntent {
    pub category: IntentCategory,
    pub search_terms: Vec<String>,
    pub time_range: Option<(i64, i64)>,
    pub app_filter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotReference {
    pub id: i64,
    pub timestamp: i64,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub file_path: String,
}

// -- System prompt --

pub const SYSTEM_PROMPT: &str = r#"You are RewindOS, a local AI assistant with access to the user's screen capture history. You answer questions about what the user has seen, done, and worked on — based on OCR text extracted from periodic screenshots.

Rules:
- Only answer based on the provided context. If the context doesn't contain relevant information, say so honestly.
- When referencing a specific screenshot, use [REF:ID] format (e.g. [REF:42]) so the UI can make it clickable.
- Be specific: mention timestamps, window titles, and app names when available.
- Use markdown for formatting (bold, lists, code blocks).
- Keep answers concise and direct. No filler.
- For productivity questions, give concrete numbers and breakdowns.
- Never fabricate information not present in the context."#;

// -- Ollama client --

pub struct OllamaChatClient {
    client: reqwest::Client,
    base_url: String,
    model: String,
    temperature: f32,
}

impl OllamaChatClient {
    pub fn new(config: &ChatConfig) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .unwrap_or_default();
        Self {
            client,
            base_url: config.ollama_url.trim_end_matches('/').to_string(),
            model: config.model.clone(),
            temperature: config.temperature,
        }
    }

    pub async fn health_check(&self) -> Result<bool> {
        let url = format!("{}/api/tags", self.base_url);
        match self.client.get(&url).send().await {
            Ok(resp) => Ok(resp.status().is_success()),
            Err(_) => Ok(false),
        }
    }

    pub fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
    ) -> impl futures::Stream<Item = Result<ChatStreamChunk>> + '_ {
        let url = format!("{}/api/chat", self.base_url);

        let ollama_messages: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| {
                serde_json::json!({
                    "role": m.role,
                    "content": m.content,
                })
            })
            .collect();

        let body = serde_json::json!({
            "model": self.model,
            "messages": ollama_messages,
            "stream": true,
            "options": {
                "temperature": self.temperature,
            }
        });

        async_stream::stream! {
            let response = self
                .client
                .post(&url)
                .json(&body)
                .send()
                .await
                .map_err(|e| CoreError::Chat(format!("request failed: {e}")))?;

            if !response.status().is_success() {
                let status = response.status();
                let body_text = response.text().await.unwrap_or_default();
                Err(CoreError::Chat(format!("ollama returned {status}: {body_text}")))?;
                return;
            }

            let mut stream = response.bytes_stream();
            let mut buffer = String::new();

            while let Some(chunk) = stream.next().await {
                let bytes = chunk.map_err(|e| CoreError::Chat(format!("stream error: {e}")))?;
                buffer.push_str(&String::from_utf8_lossy(&bytes));

                // Process complete NDJSON lines
                while let Some(newline_pos) = buffer.find('\n') {
                    let line = buffer[..newline_pos].trim().to_string();
                    buffer = buffer[newline_pos + 1..].to_string();

                    if line.is_empty() {
                        continue;
                    }

                    match serde_json::from_str::<serde_json::Value>(&line) {
                        Ok(json) => {
                            let done = json["done"].as_bool().unwrap_or(false);
                            let token = json["message"]["content"]
                                .as_str()
                                .unwrap_or("")
                                .to_string();

                            yield Ok(ChatStreamChunk { token, done });

                            if done {
                                return;
                            }
                        }
                        Err(e) => {
                            tracing::warn!("failed to parse ollama chunk: {e}, line: {line}");
                        }
                    }
                }
            }
        }
    }
}

// -- Intent classifier --

pub struct IntentClassifier;

impl IntentClassifier {
    pub fn classify(query: &str) -> QueryIntent {
        let lower = query.to_lowercase();
        let time_range = Self::extract_time_range(&lower);
        let app_filter = Self::extract_app_filter(&lower);
        let search_terms = Self::extract_search_terms(&lower);

        let category = if Self::is_productivity(&lower) {
            IntentCategory::Productivity
        } else if app_filter.is_some() {
            IntentCategory::AppSpecific
        } else if time_range.is_some() && search_terms.is_empty() {
            IntentCategory::TimeBased
        } else if !search_terms.is_empty() {
            IntentCategory::Recall
        } else {
            IntentCategory::General
        };

        QueryIntent {
            category,
            search_terms,
            time_range,
            app_filter,
        }
    }

    fn is_productivity(query: &str) -> bool {
        let keywords = [
            "how long",
            "how much time",
            "time spent",
            "productivity",
            "what did i work on",
            "what have i been doing",
            "what did i do",
            "summary",
            "summarize",
            "breakdown",
        ];
        keywords.iter().any(|k| query.contains(k))
    }

    fn extract_time_range(query: &str) -> Option<(i64, i64)> {
        let now = chrono::Local::now().timestamp();
        let today_start = now - (now % 86400);

        if query.contains("yesterday") {
            return Some((today_start - 86400, today_start));
        }
        if query.contains("today") || query.contains("this morning") {
            return Some((today_start, now));
        }
        if query.contains("this week") {
            return Some((now - 7 * 86400, now));
        }
        if query.contains("this month") {
            return Some((now - 30 * 86400, now));
        }

        // "last N hours"
        if let Some(caps) = regex_lite::Regex::new(r"last (\d+) hours?")
            .ok()
            .and_then(|re| re.captures(query))
        {
            if let Ok(hours) = caps[1].parse::<i64>() {
                return Some((now - hours * 3600, now));
            }
        }

        // "last N minutes"
        if let Some(caps) = regex_lite::Regex::new(r"last (\d+) min")
            .ok()
            .and_then(|re| re.captures(query))
        {
            if let Ok(mins) = caps[1].parse::<i64>() {
                return Some((now - mins * 60, now));
            }
        }

        None
    }

    fn extract_app_filter(query: &str) -> Option<String> {
        let app_patterns = [
            ("vs code", "code"),
            ("vscode", "code"),
            ("visual studio code", "code"),
            ("firefox", "firefox"),
            ("chrome", "google-chrome"),
            ("chromium", "chromium"),
            ("brave", "brave-browser"),
            ("terminal", "terminal"),
            ("konsole", "konsole"),
            ("kitty", "kitty"),
            ("slack", "slack"),
            ("discord", "discord"),
            ("obsidian", "obsidian"),
            ("notion", "notion"),
            ("github", "firefox"), // usually viewed in browser
            ("spotify", "spotify"),
        ];

        // "in <app>" pattern
        if let Some(caps) = regex_lite::Regex::new(r"in\s+([\w\s]+?)(?:\s+(?:yesterday|today|this|last|when|while)|\?|$)")
            .ok()
            .and_then(|re| re.captures(query))
        {
            let app_mention = caps[1].trim();
            for (pattern, app_name) in &app_patterns {
                if app_mention.contains(pattern) {
                    return Some(app_name.to_string());
                }
            }
        }

        // Direct mention anywhere
        for (pattern, app_name) in &app_patterns {
            if query.contains(pattern) {
                return Some(app_name.to_string());
            }
        }

        None
    }

    fn extract_search_terms(query: &str) -> Vec<String> {
        let stop_words = [
            "what", "was", "that", "the", "i", "saw", "in", "did", "do", "show", "me", "when",
            "how", "long", "much", "time", "spent", "on", "a", "an", "is", "it", "my", "have",
            "has", "been", "were", "are", "this", "last", "yesterday", "today", "week", "month",
            "find", "search", "look", "for", "about", "with", "from", "to", "at", "of",
            "can", "you", "tell", "give", "get",
        ];

        query
            .split_whitespace()
            .filter(|w| {
                let word = w.trim_matches(|c: char| !c.is_alphanumeric());
                word.len() > 2 && !stop_words.contains(&word)
            })
            .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_string())
            .filter(|w| !w.is_empty())
            .collect()
    }
}

// -- Context assembler --

pub struct ContextAssembler;

impl ContextAssembler {
    /// Build context string + screenshot references from search results.
    pub fn from_search_results(
        results: &[(i64, i64, Option<String>, Option<String>, String, String)],
        // (id, timestamp, app_name, window_title, file_path, ocr_text)
    ) -> (String, Vec<ScreenshotReference>) {
        let mut context = String::from("## Relevant Screenshots\n\n");
        let mut refs = Vec::new();

        for (id, timestamp, app_name, window_title, file_path, ocr_text) in results {
            let time_str = chrono::DateTime::from_timestamp(*timestamp, 0)
                .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| timestamp.to_string());

            let app = app_name.as_deref().unwrap_or("Unknown");
            let title = window_title.as_deref().unwrap_or("Untitled");
            let snippet: String = ocr_text.chars().take(500).collect();

            context.push_str(&format!(
                "### [Screenshot ID:{id}] — {time_str}\n\
                 App: {app} | Window: {title}\n\
                 Content: {snippet}\n\n"
            ));

            refs.push(ScreenshotReference {
                id: *id,
                timestamp: *timestamp,
                app_name: app_name.clone(),
                window_title: window_title.clone(),
                file_path: file_path.clone(),
            });
        }

        (context, refs)
    }

    /// Build context from OCR sessions (for time-based queries).
    pub fn from_sessions(
        sessions: &[(Option<String>, Option<String>, i64, String)],
    ) -> (String, Vec<ScreenshotReference>) {
        let mut context = String::from("## Activity Timeline\n\n");
        let refs = Vec::new();

        let mut current_app: Option<&str> = None;
        let mut group_content = Vec::new();

        for (app_name, window_title, ts, ocr_text) in sessions {
            let app = app_name.as_deref().unwrap_or("Unknown");
            let title = window_title.as_deref().unwrap_or("");
            let time_str = chrono::DateTime::from_timestamp(*ts, 0)
                .map(|dt| dt.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
                .unwrap_or_default();

            if current_app != Some(app) {
                // Flush previous group
                if !group_content.is_empty() {
                    let prev_app = current_app.unwrap_or("Unknown");
                    context.push_str(&format!("**{prev_app}**:\n"));
                    for line in &group_content {
                        context.push_str(&format!("  - {line}\n"));
                    }
                    context.push('\n');
                    group_content.clear();
                }
                current_app = Some(app);
            }

            let snippet: String = ocr_text.chars().take(150).collect();
            if !snippet.trim().is_empty() {
                group_content.push(format!("[{time_str}] {title}: {snippet}"));
            }
        }

        // Flush last group
        if !group_content.is_empty() {
            let prev_app = current_app.unwrap_or("Unknown");
            context.push_str(&format!("**{prev_app}**:\n"));
            for line in &group_content {
                context.push_str(&format!("  - {line}\n"));
            }
            context.push('\n');
        }

        (context, refs)
    }

    /// Build context from app usage stats (for productivity queries).
    pub fn from_app_stats(
        stats: &[(String, f64, usize)],
        // (app_name, minutes, session_count)
        sessions: &[(Option<String>, Option<String>, i64, String)],
    ) -> (String, Vec<ScreenshotReference>) {
        let mut context = String::from("## App Usage Breakdown\n\n");

        for (app_name, minutes, session_count) in stats {
            context.push_str(&format!(
                "- **{app_name}**: {minutes:.1} minutes ({session_count} sessions)\n"
            ));
        }

        let total: f64 = stats.iter().map(|(_, m, _)| m).sum();
        context.push_str(&format!("\n**Total tracked time**: {total:.0} minutes\n\n"));

        // Add session detail for context
        let (session_context, refs) = Self::from_sessions(sessions);
        context.push_str(&session_context);

        (context, refs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_recall() {
        let intent = IntentClassifier::classify("What was that error I saw in VS Code?");
        assert_eq!(intent.category, IntentCategory::AppSpecific);
        assert_eq!(intent.app_filter, Some("code".to_string()));
        assert!(intent.search_terms.contains(&"error".to_string()));
    }

    #[test]
    fn test_classify_productivity() {
        let intent = IntentClassifier::classify("How long did I spend on GitHub today?");
        assert_eq!(intent.category, IntentCategory::Productivity);
        assert!(intent.time_range.is_some());
    }

    #[test]
    fn test_classify_time_based() {
        let intent = IntentClassifier::classify("What happened yesterday?");
        assert_eq!(intent.category, IntentCategory::TimeBased);
        assert!(intent.time_range.is_some());
    }

    #[test]
    fn test_classify_general() {
        let intent = IntentClassifier::classify("Hi there");
        assert_eq!(intent.category, IntentCategory::General);
    }

    #[test]
    fn test_extract_time_range_last_hours() {
        let range = IntentClassifier::extract_time_range("what did i do in the last 3 hours");
        assert!(range.is_some());
        let (start, end) = range.unwrap();
        assert!(end - start >= 3 * 3600 - 10); // allow small drift
    }

    #[test]
    fn test_extract_app_filter() {
        assert_eq!(
            IntentClassifier::extract_app_filter("error in vs code"),
            Some("code".to_string())
        );
        assert_eq!(
            IntentClassifier::extract_app_filter("what was in firefox yesterday"),
            Some("firefox".to_string())
        );
    }

    #[test]
    fn test_context_from_search_results() {
        let results = vec![(
            1i64,
            1706137200i64,
            Some("firefox".to_string()),
            Some("Test Page".to_string()),
            "path.webp".to_string(),
            "Some OCR text here".to_string(),
        )];
        let (context, refs) = ContextAssembler::from_search_results(&results);
        assert!(context.contains("[Screenshot ID:1]"));
        assert!(context.contains("firefox"));
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].id, 1);
    }
}
