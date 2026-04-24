-- Nullable; NULL means "use backend default".
-- Set once on first message, not updated thereafter (UPDATE guards in chat_store).
ALTER TABLE chats ADD COLUMN model TEXT;
