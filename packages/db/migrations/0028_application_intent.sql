-- The candidate's own statement of what internships they want, given to the AI
-- fit judgment as context (never an application answer or a candidate fact).
-- Its triggers bump the AI-fit context version (0024), so a changed statement
-- marks every AI fit out of date.
CREATE TABLE IF NOT EXISTS candidate_application_intent (
  candidate_id TEXT PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS semantic_fit_application_intent_insert AFTER INSERT ON candidate_application_intent BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS semantic_fit_application_intent_update AFTER UPDATE ON candidate_application_intent BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS semantic_fit_application_intent_delete AFTER DELETE ON candidate_application_intent BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
-- The fit prompt now also weighs intent, level, and employer selectivity
-- (2026-11-19): every AI fit scored with the earlier prompt is out of date.
UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1;
