//! Message-builder helpers for the native agentic tool-calling loop
//! (`ask_agentic`). These shape the OpenAI-compatible `assistant`
//! (tool-calls) and `tool` (result) messages that get pushed back into the
//! conversation between `complete_with_tools` round-trips.
//!
//! The loop command itself lives in `lib.rs` (it needs `AppState`,
//! `persist_event`, and the Tauri `Channel`); these pure helpers are split out
//! so they can be unit-tested without a running app.

use rewindos_core::chat::ToolCall;
use serde_json::{json, Value};

/// Build the `assistant` message that carries the model's requested tool calls,
/// in OpenAI chat-completions shape. `arguments` MUST be a JSON-encoded string
/// (not a nested object), so we re-serialize each call's parsed arguments.
pub fn build_assistant_tool_calls_message(calls: &[ToolCall]) -> Value {
    let tool_calls: Vec<Value> = calls
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "type": "function",
                "function": { "name": c.name, "arguments": c.arguments.to_string() }
            })
        })
        .collect();
    json!({ "role": "assistant", "content": null, "tool_calls": tool_calls })
}

/// Build the `tool` message carrying one tool's result, keyed by the call id
/// the assistant message referenced.
pub fn build_tool_result_message(tool_call_id: &str, content: &str) -> Value {
    json!({ "role": "tool", "tool_call_id": tool_call_id, "content": content })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_message_carries_tool_calls() {
        let calls = vec![ToolCall {
            id: "c1".into(),
            name: "get_timeline".into(),
            arguments: json!({"start_time":1,"end_time":2}),
        }];
        let m = build_assistant_tool_calls_message(&calls);
        assert_eq!(m["role"], "assistant");
        assert_eq!(m["tool_calls"][0]["id"], "c1");
        assert_eq!(m["tool_calls"][0]["function"]["name"], "get_timeline");
        // arguments must be a STRING per OpenAI schema
        assert!(m["tool_calls"][0]["function"]["arguments"].is_string());
    }

    #[test]
    fn tool_result_message_shape() {
        let m = build_tool_result_message("c1", "[]");
        assert_eq!(m["role"], "tool");
        assert_eq!(m["tool_call_id"], "c1");
        assert_eq!(m["content"], "[]");
    }
}
