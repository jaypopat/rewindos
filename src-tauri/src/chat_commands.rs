use rewindos_core::chat_store::{self, ChatSearchHit};
use rewindos_core::schema::{Chat, ChatBackend, ChatMessageRow};
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
