use crate::db::Database;
use crate::error::Result;
use crate::schema::{Chat, ChatBackend};

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
}
