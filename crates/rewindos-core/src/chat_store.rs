use crate::db::Database;
use crate::error::Result;
use crate::schema::{Chat, ChatBackend, ChatRole, ChatMessageRow, BlockKind};

pub fn create_chat(
    db: &Database,
    title: &str,
    backend: ChatBackend,
    claude_session_id: Option<&str>,
) -> Result<i64> {
    let now = chrono::Local::now().timestamp();
    let conn = db.conn();
    conn.execute(
        "INSERT INTO chats (title, claude_session_id, backend, created_at, last_activity_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        rusqlite::params![title, claude_session_id, backend.as_str(), now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_chats(db: &Database, limit: i64) -> Result<Vec<Chat>> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, title, claude_session_id, backend, created_at, last_activity_at
         FROM chats ORDER BY last_activity_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        let backend_str: String = r.get(3)?;
        Ok(Chat {
            id: r.get(0)?,
            title: r.get(1)?,
            claude_session_id: r.get(2)?,
            backend: ChatBackend::parse_sql(&backend_str).unwrap_or(ChatBackend::Claude),
            created_at: r.get(4)?,
            last_activity_at: r.get(5)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

pub fn get_chat(db: &Database, chat_id: i64) -> Result<Option<Chat>> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, title, claude_session_id, backend, created_at, last_activity_at
         FROM chats WHERE id = ?1",
    )?;
    let mut rows = stmt.query([chat_id])?;
    if let Some(r) = rows.next()? {
        let backend_str: String = r.get(3)?;
        Ok(Some(Chat {
            id: r.get(0)?,
            title: r.get(1)?,
            claude_session_id: r.get(2)?,
            backend: ChatBackend::parse_sql(&backend_str).unwrap_or(ChatBackend::Claude),
            created_at: r.get(4)?,
            last_activity_at: r.get(5)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn append_message(
    db: &Database,
    chat_id: i64,
    role: ChatRole,
    block_type: BlockKind,
    content_json: &str,
    is_partial: bool,
) -> Result<i64> {
    let now = chrono::Local::now().timestamp();
    let conn = db.conn();
    conn.execute(
        "INSERT INTO chat_messages (chat_id, role, block_type, content_json, is_partial, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![chat_id, role.as_str(), block_type.as_str(), content_json, is_partial as i64, now],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE chats SET last_activity_at = ?1 WHERE id = ?2",
        rusqlite::params![now, chat_id],
    )?;
    Ok(id)
}

pub fn get_chat_messages(db: &Database, chat_id: i64) -> Result<Vec<ChatMessageRow>> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, chat_id, role, block_type, content_json, is_partial, created_at
         FROM chat_messages WHERE chat_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([chat_id], |r| {
        let role_str: String = r.get(2)?;
        let block_str: String = r.get(3)?;
        Ok(ChatMessageRow {
            id: r.get(0)?,
            chat_id: r.get(1)?,
            role: ChatRole::parse_sql(&role_str).unwrap_or(ChatRole::Assistant),
            block_type: BlockKind::parse_sql(&block_str).unwrap_or(BlockKind::Text),
            content_json: r.get(4)?,
            is_partial: r.get::<_, i64>(5)? != 0,
            created_at: r.get(6)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

pub fn mark_last_assistant_partial(db: &Database, chat_id: i64) -> Result<()> {
    let conn = db.conn();
    conn.execute(
        "UPDATE chat_messages SET is_partial = 1
         WHERE id = (
             SELECT id FROM chat_messages
             WHERE chat_id = ?1 AND role = 'assistant'
             ORDER BY id DESC LIMIT 1
         )",
        [chat_id],
    )?;
    Ok(())
}

pub fn rename_chat(db: &Database, chat_id: i64, title: &str) -> Result<()> {
    let conn = db.conn();
    conn.execute(
        "UPDATE chats SET title = ?1 WHERE id = ?2",
        rusqlite::params![title, chat_id],
    )?;
    Ok(())
}

/// Set the Claude session id for a chat, but only if it is currently NULL.
/// First-time assignment only — preserves the `WHERE claude_session_id IS NULL`
/// semantics so a later wayward event can't clobber an established session.
pub fn set_claude_session_id(db: &Database, chat_id: i64, session_id: &str) -> Result<()> {
    db.conn().execute(
        "UPDATE chats SET claude_session_id = ?1 WHERE id = ?2 AND claude_session_id IS NULL",
        rusqlite::params![session_id, chat_id],
    )?;
    Ok(())
}

pub fn delete_chat(db: &Database, chat_id: i64) -> Result<()> {
    let conn = db.conn();
    conn.execute("DELETE FROM chats WHERE id = ?1", [chat_id])?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatSearchHit {
    pub chat_id: i64,
    pub chat_title: String,
    pub message_id: i64,
    pub snippet: String,
    pub created_at: i64,
}

pub fn search_chats(db: &Database, query: &str, limit: i64) -> Result<Vec<ChatSearchHit>> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT m.chat_id, c.title, m.id,
                snippet(chat_messages_fts, 0, '<mark>', '</mark>', '…', 16),
                m.created_at
         FROM chat_messages_fts fts
         JOIN chat_messages m ON m.id = fts.rowid
         JOIN chats c ON c.id = m.chat_id
         WHERE chat_messages_fts MATCH ?1
         ORDER BY m.created_at DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![query, limit], |r| {
        Ok(ChatSearchHit {
            chat_id: r.get(0)?,
            chat_title: r.get(1)?,
            message_id: r.get(2)?,
            snippet: r.get(3)?,
            created_at: r.get(4)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_and_get_chat() {
        let db = Database::open_in_memory().unwrap();
        let id = create_chat(&db, "First chat", ChatBackend::Claude, Some("sess-abc")).unwrap();
        let chat = get_chat(&db, id).unwrap().unwrap();
        assert_eq!(chat.title, "First chat");
        assert_eq!(chat.claude_session_id.as_deref(), Some("sess-abc"));
        assert_eq!(chat.backend, ChatBackend::Claude);
    }

    #[test]
    fn list_chats_orders_by_activity_desc() {
        let db = Database::open_in_memory().unwrap();
        let a = create_chat(&db, "A", ChatBackend::Ollama, None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let b = create_chat(&db, "B", ChatBackend::Claude, Some("sess-b")).unwrap();
        let chats = list_chats(&db, 10).unwrap();
        assert_eq!(chats[0].id, b);
        assert_eq!(chats[1].id, a);
    }

    #[test]
    fn get_chat_returns_none_for_missing() {
        let db = Database::open_in_memory().unwrap();
        assert!(get_chat(&db, 9999).unwrap().is_none());
    }

    #[test]
    fn append_and_read_messages() {
        let db = Database::open_in_memory().unwrap();
        let chat = create_chat(&db, "t", ChatBackend::Claude, Some("s")).unwrap();
        append_message(&db, chat, ChatRole::User, BlockKind::Text,
            r#"{"text":"hello"}"#, false).unwrap();
        append_message(&db, chat, ChatRole::Assistant, BlockKind::Text,
            r#"{"text":"hi back"}"#, false).unwrap();
        let msgs = get_chat_messages(&db, chat).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, ChatRole::User);
        assert_eq!(msgs[1].role, ChatRole::Assistant);
        assert!(msgs[1].content_json.contains("hi back"));
    }

    #[test]
    fn append_bumps_last_activity() {
        let db = Database::open_in_memory().unwrap();
        let chat = create_chat(&db, "t", ChatBackend::Ollama, None).unwrap();
        let t1 = get_chat(&db, chat).unwrap().unwrap().last_activity_at;
        std::thread::sleep(std::time::Duration::from_millis(1100));
        append_message(&db, chat, ChatRole::User, BlockKind::Text,
            r#"{"text":"x"}"#, false).unwrap();
        let t2 = get_chat(&db, chat).unwrap().unwrap().last_activity_at;
        assert!(t2 > t1, "{t2} > {t1}");
    }

    #[test]
    fn mark_last_assistant_partial_only_touches_assistant() {
        let db = Database::open_in_memory().unwrap();
        let chat = create_chat(&db, "t", ChatBackend::Claude, Some("s")).unwrap();
        append_message(&db, chat, ChatRole::User, BlockKind::Text,
            r#"{"text":"q"}"#, false).unwrap();
        append_message(&db, chat, ChatRole::Assistant, BlockKind::Text,
            r#"{"text":"part"}"#, false).unwrap();
        mark_last_assistant_partial(&db, chat).unwrap();
        let msgs = get_chat_messages(&db, chat).unwrap();
        assert!(!msgs[0].is_partial);
        assert!(msgs[1].is_partial);
    }

    #[test]
    fn rename_updates_title() {
        let db = Database::open_in_memory().unwrap();
        let id = create_chat(&db, "old", ChatBackend::Claude, Some("s")).unwrap();
        rename_chat(&db, id, "new").unwrap();
        assert_eq!(get_chat(&db, id).unwrap().unwrap().title, "new");
    }

    #[test]
    fn set_claude_session_id_only_sets_when_null() {
        let db = Database::open_in_memory().unwrap();
        let id = create_chat(&db, "t", ChatBackend::Claude, None).unwrap();
        assert_eq!(get_chat(&db, id).unwrap().unwrap().claude_session_id, None);

        set_claude_session_id(&db, id, "sess_abc").unwrap();
        assert_eq!(
            get_chat(&db, id).unwrap().unwrap().claude_session_id.as_deref(),
            Some("sess_abc"),
        );

        // Second call must NOT overwrite — preserves WHERE claude_session_id IS NULL semantics
        set_claude_session_id(&db, id, "sess_xyz").unwrap();
        assert_eq!(
            get_chat(&db, id).unwrap().unwrap().claude_session_id.as_deref(),
            Some("sess_abc"),
        );
    }

    #[test]
    fn delete_cascades_messages_and_fts() {
        let db = Database::open_in_memory().unwrap();
        let id = create_chat(&db, "t", ChatBackend::Claude, Some("s")).unwrap();
        append_message(&db, id, ChatRole::User, BlockKind::Text,
            r#"{"text":"findme zxc"}"#, false).unwrap();
        delete_chat(&db, id).unwrap();
        assert!(get_chat(&db, id).unwrap().is_none());
        let hits = search_chats(&db, "zxc", 10).unwrap();
        assert_eq!(hits.len(), 0, "FTS should be cleaned up");
    }

    #[test]
    fn search_returns_text_block_snippets() {
        let db = Database::open_in_memory().unwrap();
        let id = create_chat(&db, "Claude session", ChatBackend::Claude, Some("s")).unwrap();
        append_message(&db, id, ChatRole::User, BlockKind::Text,
            r#"{"text":"what did I work on yesterday"}"#, false).unwrap();
        append_message(&db, id, ChatRole::Assistant, BlockKind::ToolUse,
            r#"{"id":"tu_1","name":"search_screenshots","input":{"query":"work"}}"#, false).unwrap();
        let hits = search_chats(&db, "yesterday", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("<mark>yesterday</mark>"));
        // tool_use should not appear in FTS
        let tu_hits = search_chats(&db, "search_screenshots", 10).unwrap();
        assert_eq!(tu_hits.len(), 0);
    }
}
