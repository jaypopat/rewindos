use crate::db::Database;
use crate::error::{CoreError, Result};
use crate::mcp;
use schemars::schema_for;
use serde_json::{json, Value};

fn tool_entry<T: schemars::JsonSchema>(name: &str, description: &str) -> Value {
    let schema = serde_json::to_value(schema_for!(T)).unwrap_or(json!({}));
    json!({
        "type": "function",
        "function": { "name": name, "description": description, "parameters": schema }
    })
}

pub fn tool_schemas() -> Vec<Value> {
    vec![
        tool_entry::<mcp::SearchScreenshotsInput>(
            "search_screenshots",
            "Full-text search the user's screenshots by OCR content, with optional time/app filters.",
        ),
        tool_entry::<mcp::GetTimelineInput>(
            "get_timeline",
            "List screenshots chronologically in a time range.",
        ),
        tool_entry::<mcp::GetAppUsageInput>(
            "get_app_usage",
            "App usage breakdown (minutes per app) for a time range.",
        ),
        tool_entry::<mcp::GetScreenshotDetailInput>(
            "get_screenshot_detail",
            "Fetch full OCR text and metadata for one screenshot id.",
        ),
        tool_entry::<mcp::GetRecentActivityInput>(
            "get_recent_activity",
            "Recent screenshots within the last N minutes.",
        ),
        tool_entry::<mcp::SearchTranscriptsInput>(
            "search_transcripts",
            "Search meeting transcripts; empty query lists chronologically.",
        ),
    ]
}

pub fn execute_tool(
    db: &Database,
    name: &str,
    args: &Value,
    now: i64,
    capture_interval_secs: u32,
) -> Result<String> {
    fn parse<T: serde::de::DeserializeOwned>(args: &Value) -> Result<T> {
        serde_json::from_value(args.clone())
            .map_err(|e| CoreError::Other(format!("bad tool args: {e}")))
    }
    let out: Value = match name {
        "search_screenshots" => json!(mcp::search_screenshots(db, parse(args)?)?),
        "get_timeline" => json!(mcp::get_timeline(db, parse(args)?)?),
        "get_app_usage" => json!(mcp::get_app_usage(db, parse(args)?, capture_interval_secs)?),
        "get_screenshot_detail" => json!(mcp::get_screenshot_detail(db, parse(args)?)?),
        "get_recent_activity" => json!(mcp::get_recent_activity(db, parse(args)?, now)?),
        "search_transcripts" => json!(mcp::search_transcripts(db, parse(args)?, now)?),
        other => return Err(CoreError::Other(format!("unknown tool: {other}"))),
    };
    serde_json::to_string(&out).map_err(|e| CoreError::Other(format!("serialize tool result: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schemas_cover_all_six_tools() {
        let schemas = tool_schemas();
        let names: Vec<String> = schemas
            .iter()
            .map(|s| s["function"]["name"].as_str().unwrap().to_string())
            .collect();
        for expected in [
            "search_screenshots",
            "get_timeline",
            "get_app_usage",
            "get_screenshot_detail",
            "get_recent_activity",
            "search_transcripts",
        ] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
    }

    #[test]
    fn execute_search_returns_json_with_seeded_row() {
        let db = Database::open_in_memory().unwrap();
        let args = json!({ "query": "rust async", "limit": 5 });
        let out = execute_tool(&db, "search_screenshots", &args, 1_700_000_000, 5).unwrap();
        // Valid JSON array (empty is fine — no rows seeded), proves dispatch + serialize.
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(parsed.is_array());
    }

    #[test]
    fn execute_unknown_tool_errors() {
        let db = Database::open_in_memory().unwrap();
        assert!(execute_tool(&db, "no_such_tool", &serde_json::Value::Null, 0, 5).is_err());
    }
}
