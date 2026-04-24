use rewindos_core::chat_store::{self, ChatSearchHit};
use rewindos_core::schema::{BlockKind, Chat, ChatBackend, ChatMessageRow, ChatRole};
use tauri::State;

use crate::AppState;

#[tauri::command]
pub fn list_chats(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<Chat>, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::list_chats(&db, limit.unwrap_or(100)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_chat_messages(
    state: State<'_, AppState>,
    chat_id: i64,
) -> Result<Vec<ChatMessageRow>, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::get_chat_messages(&db, chat_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_chat(
    state: State<'_, AppState>,
    title: String,
    backend: String,
    claude_session_id: Option<String>,
) -> Result<i64, String> {
    let backend_enum = ChatBackend::parse_sql(&backend)
        .ok_or_else(|| format!("invalid backend: {backend}"))?;
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::create_chat(&db, &title, backend_enum, claude_session_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_chat(
    state: State<'_, AppState>,
    chat_id: i64,
    title: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::rename_chat(&db, chat_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_model(
    state: State<'_, AppState>,
    chat_id: i64,
    model: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::set_chat_model(&db, chat_id, &model).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chat(state: State<'_, AppState>, chat_id: i64) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::delete_chat(&db, chat_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_chats(
    state: State<'_, AppState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<ChatSearchHit>, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::search_chats(&db, &query, limit.unwrap_or(50)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn append_chat_message(
    state: State<'_, AppState>,
    chat_id: i64,
    role: String,
    block_type: String,
    content_json: String,
    is_partial: bool,
) -> Result<i64, String> {
    let role_enum = ChatRole::parse_sql(&role).ok_or_else(|| format!("bad role: {role}"))?;
    let block_enum =
        BlockKind::parse_sql(&block_type).ok_or_else(|| format!("bad block: {block_type}"))?;
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    chat_store::append_message(&db, chat_id, role_enum, block_enum, &content_json, is_partial)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_chat_markdown(
    state: State<'_, AppState>,
    chat_id: i64,
) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| format!("db lock: {e}"))?;
    let chat = chat_store::get_chat(&db, chat_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("chat {chat_id} not found"))?;
    let messages = chat_store::get_chat_messages(&db, chat_id).map_err(|e| e.to_string())?;

    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", chat.title));
    out.push_str(&format!(
        "> {} · {} messages · started {}\n\n",
        chat.backend.as_str(),
        messages.len(),
        chrono::DateTime::from_timestamp(chat.created_at, 0)
            .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_default(),
    ));

    for m in messages {
        let body: serde_json::Value =
            serde_json::from_str(&m.content_json).unwrap_or_default();
        match m.block_type {
            BlockKind::Text => {
                let speaker = match m.role {
                    ChatRole::User => "**You**",
                    ChatRole::Assistant => "**Claude**",
                };
                out.push_str(&format!(
                    "{}: {}\n\n",
                    speaker,
                    body.get("text").and_then(|t| t.as_str()).unwrap_or(""),
                ));
            }
            BlockKind::ToolUse => {
                let name = body.get("name").and_then(|n| n.as_str()).unwrap_or("?");
                let input = body.get("input").map(|i| i.to_string()).unwrap_or_default();
                out.push_str(&format!("> 🔧 `{name}({input})`\n\n"));
            }
            BlockKind::ToolResult => {
                let content = body.get("content").and_then(|c| c.as_str()).unwrap_or("");
                out.push_str(&format!(
                    "> ↳ ```\n> {}\n> ```\n\n",
                    content.replace('\n', "\n> "),
                ));
            }
            BlockKind::Thinking => {
                let text = body.get("text").and_then(|t| t.as_str()).unwrap_or("");
                out.push_str(&format!("> 💭 _{text}_\n\n"));
            }
        }
    }
    Ok(out)
}
