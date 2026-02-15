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

#[derive(Debug, Clone, PartialEq)]
pub enum QueryConfidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone)]
pub struct QueryIntent {
    pub category: IntentCategory,
    pub search_terms: Vec<String>,
    pub time_range: Option<(i64, i64)>,
    pub app_filter: Option<String>,
    pub confidence: QueryConfidence,
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

## Core Rules
- Answer the user's question directly. Start with the answer, not preamble.
- When referencing a specific screenshot, use [REF:ID] format (e.g. [REF:42]) so the UI can make it clickable.
- Be specific: mention timestamps, window titles, and app names from the context.
- Use markdown for formatting (bold, lists, code blocks).
- Never fabricate information not present in the context.
- Ignore screenshots showing the RewindOS app itself.
- If the context has no relevant data, say "I don't have enough screen history for that time period."

## Response Strategy by Query Type
- **Productivity** ("what did I work on", "how long"): Group activities by task/project, not individual screenshots. Estimate time spent per task. Highlight the most significant work.
- **Recall** ("last time I saw", "find"): Lead with the best matching screenshot. Quote the relevant OCR text. Present matches chronologically.
- **Time-based** ("what happened yesterday"): Describe the activity flow with transitions between apps/tasks. Note significant gaps in activity.
- **App-specific** ("what was I doing in VS Code"): Focus on what was done in the app — files edited, pages visited, messages sent. Summarize by activity, not timestamp.

## Format
- Keep answers under 300 words. Be conversational but precise.
- No filler phrases like "Based on the provided context" or "Let me analyze".
- NEVER just rephrase or repeat the user's question back."#;

// -- Ollama client --

pub struct OllamaChatClient {
    client: reqwest::Client,
    base_url: String,
    model: String,
    temperature: f32,
}

impl OllamaChatClient {
    pub fn new(config: &ChatConfig) -> Self {
        // Only set connect_timeout — no global timeout so streaming responses
        // aren't killed when generation takes longer than a fixed duration.
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
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

const QUERY_ANALYSIS_PROMPT: &str = r#"You are a query analyzer for a screen capture search system. The system captures screenshots periodically and runs OCR on them. Given a user's question, extract structured search parameters so we can find relevant screenshots.

Output ONLY valid JSON (no markdown fences, no explanation) with these fields:
- "category": one of "recall", "time_based", "productivity", "app_specific", "general"
  - "recall": user wants to find something specific they saw/did
  - "time_based": user asks about a time period without specific keywords (e.g. "what happened yesterday?")
  - "productivity": user asks about time spent, productivity, summaries of work
  - "app_specific": user asks about a specific application
  - "general": greeting or unrelated question
- "search_terms": array of distinctive keywords to search in OCR text. Focus on specific nouns, proper nouns, and technical terms that would appear on screen. Omit common verbs like "played", "used", "opened", "visited". Example: "last time I played chess" → ["chess"]
- "time_range_seconds": how far back to search in seconds, or null if not specified. Common values: 3600 (1 hour), 86400 (1 day/today/yesterday), 604800 (1 week), 2592000 (30 days). For "last time" / "when did" / "when was" queries use 2592000.
- "app_filter": lowercase process name if query targets a specific app, or null. Known mappings: "vs code"/"vscode" → "code", "chrome" → "google-chrome", "brave" → "brave-browser". Others use lowercase name directly (firefox, konsole, kitty, slack, discord, obsidian, spotify).
- "confidence": how confident you are in the search parameters: "high" (specific query with clear terms), "medium" (reasonable interpretation), "low" (vague or ambiguous query)

Examples:
User: "last time I played chess?" → {"category":"recall","search_terms":["chess"],"time_range_seconds":2592000,"app_filter":null,"confidence":"high"}
User: "what was I doing yesterday?" → {"category":"time_based","search_terms":[],"time_range_seconds":86400,"app_filter":null,"confidence":"high"}
User: "errors in vs code today" → {"category":"app_specific","search_terms":["error"],"time_range_seconds":86400,"app_filter":"code","confidence":"high"}
User: "how long on firefox this week?" → {"category":"productivity","search_terms":[],"time_range_seconds":604800,"app_filter":"firefox","confidence":"high"}
User: "that thing I was looking at" → {"category":"recall","search_terms":[],"time_range_seconds":86400,"app_filter":null,"confidence":"low"}
User: "something about databases" → {"category":"recall","search_terms":["database","sql","postgres","mysql"],"time_range_seconds":2592000,"app_filter":null,"confidence":"medium"}"#;

impl OllamaChatClient {
    /// Use the LLM to analyze a user query and extract structured search parameters.
    pub async fn analyze_query(&self, query: &str) -> Result<QueryIntent> {
        let prompt = format!("{QUERY_ANALYSIS_PROMPT}\n\nUser: \"{query}\"");

        let body = serde_json::json!({
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": false,
            "options": {
                "temperature": 0.0,
                "num_predict": 300,
            }
        });

        let url = format!("{}/api/chat", self.base_url);
        let response = self
            .client
            .post(&url)
            .timeout(std::time::Duration::from_secs(120))
            .json(&body)
            .send()
            .await
            .map_err(|e| CoreError::Chat(format!("analyze_query request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            return Err(CoreError::Chat(format!("analyze_query failed: {status}")));
        }

        let resp_json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| CoreError::Chat(format!("parse analyze_query response: {e}")))?;

        let content = resp_json["message"]["content"].as_str().unwrap_or("{}");

        // Strip <think>...</think> blocks (reasoning models like deepseek-r1)
        let clean = if let Ok(re) = regex_lite::Regex::new(r"(?s)<think>.*?</think>") {
            re.replace_all(content, "").trim().to_string()
        } else {
            content.to_string()
        };

        // Strip markdown code fences if present
        let clean = clean.trim();
        let clean = clean.strip_prefix("```json").unwrap_or(clean);
        let clean = clean.strip_prefix("```").unwrap_or(clean);
        let clean = clean.strip_suffix("```").unwrap_or(clean).trim();

        Self::parse_intent_json(clean)
    }

    fn parse_intent_json(json_str: &str) -> Result<QueryIntent> {
        let v: serde_json::Value = serde_json::from_str(json_str).map_err(|e| {
            CoreError::Chat(format!("failed to parse intent JSON: {e}, raw: {json_str}"))
        })?;

        let now = chrono::Local::now().timestamp();

        let category = match v["category"].as_str().unwrap_or("general") {
            "recall" => IntentCategory::Recall,
            "time_based" => IntentCategory::TimeBased,
            "productivity" => IntentCategory::Productivity,
            "app_specific" => IntentCategory::AppSpecific,
            _ => IntentCategory::General,
        };

        let search_terms: Vec<String> = v["search_terms"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        let time_range = v["time_range_seconds"]
            .as_i64()
            .map(|secs| (now - secs, now));

        let app_filter = v["app_filter"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(String::from);

        let confidence = match v["confidence"].as_str().unwrap_or("medium") {
            "high" => QueryConfidence::High,
            "low" => QueryConfidence::Low,
            _ => QueryConfidence::Medium,
        };

        Ok(QueryIntent {
            category,
            search_terms,
            time_range,
            app_filter,
            confidence,
        })
    }
}

// -- Intent classifier (regex fallback) --

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
            confidence: QueryConfidence::Medium,
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

        // "last N days"
        if let Some(caps) = regex_lite::Regex::new(r"last (\d+) days?")
            .ok()
            .and_then(|re| re.captures(query))
        {
            if let Ok(days) = caps[1].parse::<i64>() {
                return Some((now - days * 86400, now));
            }
        }

        // "last week"
        if query.contains("last week") {
            return Some((now - 7 * 86400, now));
        }

        // "last time", "when did", "when was" → search last 30 days
        if query.contains("last time")
            || query.starts_with("when did")
            || query.starts_with("when was")
        {
            return Some((now - 30 * 86400, now));
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
        if let Some(caps) = regex_lite::Regex::new(
            r"in\s+([\w\s]+?)(?:\s+(?:yesterday|today|this|last|when|while)|\?|$)",
        )
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
            "what",
            "was",
            "that",
            "the",
            "i",
            "saw",
            "in",
            "did",
            "do",
            "show",
            "me",
            "when",
            "how",
            "long",
            "much",
            "time",
            "spent",
            "on",
            "a",
            "an",
            "is",
            "it",
            "my",
            "have",
            "has",
            "been",
            "were",
            "are",
            "this",
            "last",
            "yesterday",
            "today",
            "week",
            "month",
            "find",
            "search",
            "look",
            "for",
            "about",
            "with",
            "from",
            "to",
            "at",
            "of",
            "can",
            "you",
            "tell",
            "give",
            "get",
            "happened",
            "there",
            "doing",
            "worked",
            "working",
            "used",
            "using",
            "opened",
            "visited",
            "played",
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

/// Simple content hash for deduplication. Hashes the first 30 whitespace-normalized words.
fn simple_content_hash(text: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let normalized: String = text
        .split_whitespace()
        .take(30)
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();

    let mut hasher = DefaultHasher::new();
    normalized.hash(&mut hasher);
    hasher.finish()
}

pub struct ContextAssembler;

impl ContextAssembler {
    /// Build context string + screenshot references from search results.
    pub fn from_search_results(
        results: &[(i64, i64, Option<String>, Option<String>, String, String)],
        // (id, timestamp, app_name, window_title, file_path, ocr_text)
    ) -> (String, Vec<ScreenshotReference>) {
        let mut seen_hashes = std::collections::HashSet::new();
        let mut deduped_results = Vec::new();

        for entry in results {
            let hash = simple_content_hash(&entry.5);
            if seen_hashes.insert(hash) {
                deduped_results.push(entry);
            }
        }

        let mut context = format!(
            "## Relevant Screenshots (showing {} results)\n\n",
            deduped_results.len()
        );
        let mut refs = Vec::new();

        for (id, timestamp, app_name, window_title, file_path, ocr_text) in deduped_results {
            let time_str = chrono::DateTime::from_timestamp(*timestamp, 0)
                .map(|dt| {
                    dt.with_timezone(&chrono::Local)
                        .format("%Y-%m-%d %H:%M:%S")
                        .to_string()
                })
                .unwrap_or_else(|| timestamp.to_string());

            let app = app_name.as_deref().unwrap_or("Unknown");
            let title = window_title.as_deref().unwrap_or("Untitled");
            let snippet: String = ocr_text.chars().take(1000).collect();

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

    /// Build context with token budgeting from search results.
    /// Dynamically sizes OCR snippets to fit within `max_context_tokens`.
    pub fn from_search_results_budgeted(
        results: &[(i64, i64, Option<String>, Option<String>, String, String)],
        max_context_tokens: usize,
    ) -> (String, Vec<ScreenshotReference>) {
        let mut seen_hashes = std::collections::HashSet::new();
        let mut deduped_results = Vec::new();

        for entry in results {
            let hash = simple_content_hash(&entry.5);
            if seen_hashes.insert(hash) {
                deduped_results.push(entry);
            }
        }

        let header = format!(
            "## Relevant Screenshots (showing {} results)\n\n",
            deduped_results.len()
        );
        let mut context = header.clone();
        let mut refs = Vec::new();
        // Estimate tokens as chars / 4
        let mut budget_remaining = max_context_tokens.saturating_sub(header.len() / 4);

        for (id, timestamp, app_name, window_title, file_path, ocr_text) in deduped_results {
            if budget_remaining < 100 {
                break;
            }

            let time_str = chrono::DateTime::from_timestamp(*timestamp, 0)
                .map(|dt| {
                    dt.with_timezone(&chrono::Local)
                        .format("%Y-%m-%d %H:%M:%S")
                        .to_string()
                })
                .unwrap_or_else(|| timestamp.to_string());

            let app = app_name.as_deref().unwrap_or("Unknown");
            let title = window_title.as_deref().unwrap_or("Untitled");

            // Dynamic snippet size: use remaining budget, capped at 1000 chars
            let max_snippet_chars = (budget_remaining * 4).min(1000);
            let snippet: String = ocr_text.chars().take(max_snippet_chars).collect();

            let entry_text = format!(
                "### [Screenshot ID:{id}] — {time_str}\n\
                 App: {app} | Window: {title}\n\
                 Content: {snippet}\n\n"
            );

            let entry_tokens = entry_text.len() / 4;
            budget_remaining = budget_remaining.saturating_sub(entry_tokens);

            context.push_str(&entry_text);

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
        let now_str = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let mut context = format!(
            "## Activity Timeline (current time: {}, {} entries)\n\n",
            now_str,
            sessions.len()
        );
        let refs = Vec::new();

        let mut current_app: Option<&str> = None;
        let mut group_content = Vec::new();

        for (app_name, window_title, ts, ocr_text) in sessions {
            let app = app_name.as_deref().unwrap_or("Unknown");
            let title = window_title.as_deref().unwrap_or("");
            let time_str = chrono::DateTime::from_timestamp(*ts, 0)
                .map(|dt| {
                    dt.with_timezone(&chrono::Local)
                        .format("%H:%M:%S")
                        .to_string()
                })
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

            let snippet: String = ocr_text.chars().take(400).collect();
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

    /// Build context from OCR sessions that include screenshot IDs and file paths.
    /// Produces `ScreenshotReference` entries so the LLM can output `[REF:ID]` tags.
    /// Caps references at `max_refs` (default 20) and applies token budgeting.
    pub fn from_sessions_with_refs(
        sessions: &[(i64, Option<String>, Option<String>, i64, String, String)],
        // (id, app_name, window_title, timestamp, file_path, ocr_text)
    ) -> (String, Vec<ScreenshotReference>) {
        Self::from_sessions_with_refs_budgeted(sessions, 4096, 20)
    }

    /// Token-budgeted variant of `from_sessions_with_refs`.
    pub fn from_sessions_with_refs_budgeted(
        sessions: &[(i64, Option<String>, Option<String>, i64, String, String)],
        max_context_tokens: usize,
        max_refs: usize,
    ) -> (String, Vec<ScreenshotReference>) {
        let now_str = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let header = format!(
            "## Activity Timeline (current time: {}, {} entries)\n\n",
            now_str,
            sessions.len()
        );
        let mut context = header.clone();
        let mut refs = Vec::new();
        let mut budget_remaining = max_context_tokens.saturating_sub(header.len() / 4);

        let mut current_app: Option<&str> = None;
        let mut group_content = Vec::new();

        for (id, app_name, window_title, ts, file_path, ocr_text) in sessions {
            if budget_remaining < 50 {
                break;
            }

            let app = app_name.as_deref().unwrap_or("Unknown");
            let title = window_title.as_deref().unwrap_or("");
            let time_str = chrono::DateTime::from_timestamp(*ts, 0)
                .map(|dt| {
                    dt.with_timezone(&chrono::Local)
                        .format("%H:%M:%S")
                        .to_string()
                })
                .unwrap_or_default();

            if current_app != Some(app) {
                if !group_content.is_empty() {
                    let prev_app = current_app.unwrap_or("Unknown");
                    let group_text = format!("**{prev_app}**:\n");
                    let lines_text: String = group_content
                        .iter()
                        .map(|line| format!("  - {line}\n"))
                        .collect();
                    let block_tokens = (group_text.len() + lines_text.len()) / 4;
                    budget_remaining = budget_remaining.saturating_sub(block_tokens);
                    context.push_str(&group_text);
                    context.push_str(&lines_text);
                    context.push('\n');
                    group_content.clear();
                }
                current_app = Some(app);
            }

            // Dynamic snippet size based on remaining budget, capped at 400
            let max_snippet = (budget_remaining * 4 / 4).min(400); // conservative
            let snippet: String = ocr_text.chars().take(max_snippet).collect();
            if !snippet.trim().is_empty() {
                group_content.push(format!("[{time_str}] [REF:{id}] {title}: {snippet}"));
            }

            if refs.len() < max_refs {
                refs.push(ScreenshotReference {
                    id: *id,
                    timestamp: *ts,
                    app_name: app_name.clone(),
                    window_title: window_title.clone(),
                    file_path: file_path.clone(),
                });
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
    /// Accepts the richer session tuple with screenshot IDs so references can be
    /// produced for the LLM to link back to specific captures.
    pub fn from_app_stats(
        stats: &[(String, f64, usize)],
        // (app_name, minutes, session_count)
        sessions: &[(i64, Option<String>, Option<String>, i64, String, String)],
        // (id, app_name, window_title, timestamp, file_path, ocr_text)
        max_context_tokens: usize,
    ) -> (String, Vec<ScreenshotReference>) {
        let mut context = String::from("## App Usage Breakdown\n\n");

        for (app_name, minutes, session_count) in stats {
            context.push_str(&format!(
                "- **{app_name}**: {minutes:.1} minutes ({session_count} sessions)\n"
            ));
        }

        let total: f64 = stats.iter().map(|(_, m, _)| m).sum();
        context.push_str(&format!("\n**Total tracked time**: {total:.0} minutes\n\n"));

        // Reserve remaining budget for session detail
        let used_tokens = context.len() / 4;
        let remaining_budget = max_context_tokens.saturating_sub(used_tokens);

        let (session_context, refs) =
            Self::from_sessions_with_refs_budgeted(sessions, remaining_budget, 20);
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
    fn test_extract_time_range_last_time() {
        let range = IntentClassifier::extract_time_range("last time i played chess");
        assert!(range.is_some());
        let (start, end) = range.unwrap();
        // Should be ~30 days
        assert!(end - start >= 29 * 86400);
    }

    #[test]
    fn test_extract_time_range_when_did() {
        let range = IntentClassifier::extract_time_range("when did i visit that website");
        assert!(range.is_some());
        let (start, end) = range.unwrap();
        assert!(end - start >= 29 * 86400);
    }

    #[test]
    fn test_extract_time_range_when_was() {
        let range = IntentClassifier::extract_time_range("when was the last meeting");
        assert!(range.is_some());
    }

    #[test]
    fn test_extract_time_range_last_week() {
        let range = IntentClassifier::extract_time_range("what did i do last week");
        assert!(range.is_some());
        let (start, end) = range.unwrap();
        assert!(end - start >= 6 * 86400);
        assert!(end - start <= 8 * 86400);
    }

    #[test]
    fn test_extract_time_range_last_n_days() {
        let range = IntentClassifier::extract_time_range("show me activity from the last 5 days");
        assert!(range.is_some());
        let (start, end) = range.unwrap();
        assert!(end - start >= 4 * 86400);
        assert!(end - start <= 6 * 86400);
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
