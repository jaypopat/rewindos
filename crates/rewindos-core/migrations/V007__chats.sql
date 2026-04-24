CREATE TABLE chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    claude_session_id TEXT,
    backend TEXT NOT NULL CHECK (backend IN ('claude', 'ollama')),
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
);

CREATE INDEX idx_chats_last_activity ON chats(last_activity_at DESC);
CREATE UNIQUE INDEX idx_chats_claude_session
    ON chats(claude_session_id)
    WHERE claude_session_id IS NOT NULL;

CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    block_type TEXT NOT NULL CHECK (block_type IN ('text', 'tool_use', 'tool_result', 'thinking')),
    content_json TEXT NOT NULL,
    is_partial INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_chat_messages_chat ON chat_messages(chat_id, created_at);

CREATE VIRTUAL TABLE chat_messages_fts USING fts5(body);

CREATE TRIGGER chat_messages_ai AFTER INSERT ON chat_messages
WHEN NEW.block_type IN ('text', 'thinking')
BEGIN
    INSERT INTO chat_messages_fts(rowid, body)
    VALUES (NEW.id, json_extract(NEW.content_json, '$.text'));
END;

CREATE TRIGGER chat_messages_ad AFTER DELETE ON chat_messages
WHEN OLD.block_type IN ('text', 'thinking')
BEGIN
    DELETE FROM chat_messages_fts WHERE rowid = OLD.id;
END;
