-- Courses the candidate entered from their own transcript with
-- pnpm profile:coursework: code, title, term, completed or in progress.
-- No grades and no student ID; the transcript file itself is never parsed.
-- Used for the "Relevant coursework" answer and as citable AI-fit evidence.
-- Its triggers bump the AI-fit context version (0024), so a changed set
-- marks every AI fit out of date.
CREATE TABLE IF NOT EXISTS candidate_coursework (
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  school TEXT NOT NULL CHECK (length(school) BETWEEN 1 AND 160),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  term TEXT NOT NULL CHECK (length(term) BETWEEN 1 AND 40),
  status TEXT NOT NULL CHECK (status IN ('completed', 'in_progress')),
  source TEXT NOT NULL CHECK (source = 'candidate_confirmed_transcript'),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (candidate_id, position)
);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_coursework_code ON candidate_coursework(candidate_id, code COLLATE NOCASE);
CREATE TRIGGER IF NOT EXISTS semantic_fit_coursework_insert AFTER INSERT ON candidate_coursework BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS semantic_fit_coursework_update AFTER UPDATE ON candidate_coursework BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS semantic_fit_coursework_delete AFTER DELETE ON candidate_coursework BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
-- The fit prompt now explains course evidence (2026-11-19): every AI fit
-- scored with the earlier prompt is out of date.
UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1;
