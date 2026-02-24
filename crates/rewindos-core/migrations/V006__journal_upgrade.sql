-- Mood/energy on journal_entries
ALTER TABLE journal_entries ADD COLUMN mood INTEGER;
ALTER TABLE journal_entries ADD COLUMN energy INTEGER;
ALTER TABLE journal_entries ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0;

-- Backfill word count
UPDATE journal_entries SET word_count = (
  length(content) - length(replace(content, ' ', '')) + 1
) WHERE length(content) > 0;

-- Tags
CREATE TABLE journal_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE journal_entry_tags (
  journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES journal_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (journal_entry_id, tag_id)
);
CREATE INDEX idx_journal_entry_tags_tag ON journal_entry_tags(tag_id);

-- Journal FTS5
CREATE VIRTUAL TABLE journal_fts USING fts5(
  content, entry_id UNINDEXED,
  tokenize='unicode61 remove_diacritics 2'
);
INSERT INTO journal_fts (content, entry_id)
  SELECT content, id FROM journal_entries WHERE length(content) > 0;

-- Templates (4 built-in, bullet-point format)
CREATE TABLE journal_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO journal_templates (name, description, content, is_builtin, sort_order) VALUES
  ('Daily Reflection', 'End-of-day reflection',
   '- What went well today?
  -
- What could have gone better?
  -
- What did I learn?
  -
- Grateful for:
  - ', 1, 0),
  ('Standup', 'Quick standup format',
   '- **Yesterday**
  -
- **Today**
  -
- **Blockers**
  - ', 1, 1),
  ('Gratitude', 'Three things',
   '- Grateful for:
  -
  -
  -
- Why these matter:
  - ', 1, 2),
  ('Weekly Review', 'End-of-week',
   '- **Highlights**
  -
- **Challenges**
  -
- **Lessons**
  -
- **Next week goals**
  - [ ]
  - [ ]
  - [ ] ', 1, 3);

-- AI summary cache
CREATE TABLE journal_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_type TEXT NOT NULL,
  period_key TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  model_name TEXT,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(period_type, period_key)
);
