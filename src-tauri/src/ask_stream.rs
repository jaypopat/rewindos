use serde::{Deserialize, Serialize};

/// Events we emit to the frontend via a Tauri Channel. A clean discriminated
/// union — one event per content block + lifecycle signals.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AskStreamEvent {
    /// Session id returned by Claude on first event. Frontend records this
    /// on the chat row so subsequent turns can --resume it.
    SessionStarted { session_id: String },
    /// A text block landed (stream-json does full blocks, not per-token).
    Text { text: String },
    /// Claude invoked an MCP tool.
    ToolUse { id: String, name: String, input: serde_json::Value },
    /// MCP tool returned a result.
    ToolResult { tool_use_id: String, content: String, is_error: bool },
    /// Extended thinking block (only if extended thinking is on).
    Thinking { text: String },
    /// Final turn completed successfully.
    Done { total_cost_usd: Option<f64> },
    /// Fatal error (non-zero exit, parse failure, etc.).
    Error { message: String },
}

/// Parse a single NDJSON line from `claude --output-format stream-json` into
/// zero-or-more AskStreamEvents.
///
/// Claude's stream-json shape (as of 2.x):
///   { "type":"system", "subtype":"init", "session_id":"...", ... }
///   { "type":"assistant", "message":{ "content":[ <blocks> ] } }
///   { "type":"user",      "message":{ "content":[ <tool_result_blocks> ] } }
///   { "type":"result",    "subtype":"success", "total_cost_usd":..., "result":"..." }
pub fn parse_line(line: &str) -> Vec<AskStreamEvent> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return vec![];
    };
    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match ty {
        "system" => {
            if v.get("subtype").and_then(|s| s.as_str()) == Some("init") {
                if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                    return vec![AskStreamEvent::SessionStarted {
                        session_id: sid.to_string(),
                    }];
                }
            }
            vec![]
        }
        "assistant" => extract_blocks(&v, false),
        "user" => extract_blocks(&v, true),
        "result" => {
            let cost = v.get("total_cost_usd").and_then(|c| c.as_f64());
            // Some variants emit a "result" wrapping an error — surface it.
            if v.get("subtype").and_then(|s| s.as_str()) == Some("error") {
                let msg = v.get("result").and_then(|r| r.as_str()).unwrap_or("claude error");
                vec![AskStreamEvent::Error { message: msg.to_string() }]
            } else {
                vec![AskStreamEvent::Done { total_cost_usd: cost }]
            }
        }
        _ => vec![],
    }
}

fn extract_blocks(v: &serde_json::Value, is_user_role: bool) -> Vec<AskStreamEvent> {
    let blocks = v
        .pointer("/message/content")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();

    blocks
        .into_iter()
        .filter_map(|b| {
            let kind = b.get("type").and_then(|t| t.as_str())?;
            match kind {
                "text" if !is_user_role => {
                    let text = b.get("text").and_then(|t| t.as_str())?.to_string();
                    Some(AskStreamEvent::Text { text })
                }
                "thinking" if !is_user_role => {
                    let text = b.get("text").and_then(|t| t.as_str())?.to_string();
                    Some(AskStreamEvent::Thinking { text })
                }
                "tool_use" if !is_user_role => {
                    let id = b.get("id").and_then(|t| t.as_str())?.to_string();
                    let name = b.get("name").and_then(|t| t.as_str())?.to_string();
                    let input = b.get("input").cloned().unwrap_or(serde_json::Value::Null);
                    Some(AskStreamEvent::ToolUse { id, name, input })
                }
                "tool_result" if is_user_role => {
                    let tool_use_id = b.get("tool_use_id").and_then(|t| t.as_str())?.to_string();
                    let content = b
                        .get("content")
                        .and_then(|c| {
                            // content can be a string OR an array of {type:"text",text:"..."}
                            c.as_str().map(|s| s.to_string()).or_else(|| {
                                c.as_array().map(|arr| {
                                    arr.iter()
                                        .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                })
                            })
                        })
                        .unwrap_or_default();
                    let is_error = b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                    Some(AskStreamEvent::ToolResult { tool_use_id, content, is_error })
                }
                _ => None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_system_init() {
        let line = r#"{"type":"system","subtype":"init","session_id":"abc123"}"#;
        let evs = parse_line(line);
        assert!(matches!(
            evs.as_slice(),
            [AskStreamEvent::SessionStarted { session_id }] if session_id == "abc123"
        ));
    }

    #[test]
    fn parses_assistant_text() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#;
        let evs = parse_line(line);
        assert!(matches!(evs.as_slice(), [AskStreamEvent::Text { text }] if text == "hi"));
    }

    #[test]
    fn parses_assistant_tool_use() {
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"tool_use","id":"tu_1","name":"search_screenshots","input":{"query":"rust"}}
        ]}}"#;
        let evs = parse_line(line);
        match &evs[..] {
            [AskStreamEvent::ToolUse { id, name, input }] => {
                assert_eq!(id, "tu_1");
                assert_eq!(name, "search_screenshots");
                assert_eq!(input.get("query").unwrap().as_str().unwrap(), "rust");
            }
            _ => panic!("unexpected: {evs:?}"),
        }
    }

    #[test]
    fn parses_user_tool_result_string_content() {
        let line = r#"{"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"tu_1","content":"3 results"}
        ]}}"#;
        let evs = parse_line(line);
        match &evs[..] {
            [AskStreamEvent::ToolResult { tool_use_id, content, is_error }] => {
                assert_eq!(tool_use_id, "tu_1");
                assert_eq!(content, "3 results");
                assert!(!*is_error);
            }
            _ => panic!("unexpected: {evs:?}"),
        }
    }

    #[test]
    fn parses_user_tool_result_array_content() {
        let line = r#"{"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"tu_2","content":[
                {"type":"text","text":"line one"},
                {"type":"text","text":"line two"}
            ]}
        ]}}"#;
        let evs = parse_line(line);
        assert!(matches!(
            evs.as_slice(),
            [AskStreamEvent::ToolResult { content, .. }] if content == "line one\nline two"
        ));
    }

    #[test]
    fn parses_result_done() {
        let line = r#"{"type":"result","subtype":"success","total_cost_usd":0.0012,"result":"final"}"#;
        let evs = parse_line(line);
        assert!(matches!(
            evs.as_slice(),
            [AskStreamEvent::Done { total_cost_usd: Some(c) }] if (c - 0.0012).abs() < 1e-9
        ));
    }

    #[test]
    fn parses_result_error() {
        let line = r#"{"type":"result","subtype":"error","result":"rate limited"}"#;
        let evs = parse_line(line);
        assert!(matches!(
            evs.as_slice(),
            [AskStreamEvent::Error { message }] if message == "rate limited"
        ));
    }

    #[test]
    fn junk_lines_yield_nothing() {
        assert!(parse_line("not json").is_empty());
        assert!(parse_line("").is_empty());
        assert!(parse_line(r#"{"type":"unknown"}"#).is_empty());
    }
}
