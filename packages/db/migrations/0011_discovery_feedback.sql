-- Explicit candidate decisions about discovered postings. Skips affect the
-- review queue, but never become candidate preferences or application answers.
CREATE TABLE discovery_feedback (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision = 'SKIP'),
  reason TEXT NOT NULL,
  preference_note TEXT,
  created_at TEXT NOT NULL
);
