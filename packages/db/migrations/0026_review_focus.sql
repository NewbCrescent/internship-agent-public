-- The Review Queue's focus view settings: one row per workspace. Kept apart
-- from candidate_preferences, whose triggers (0024) bump the AI-fit context
-- version and would mark every AI score out of date on each change.
CREATE TABLE IF NOT EXISTS review_focus (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
