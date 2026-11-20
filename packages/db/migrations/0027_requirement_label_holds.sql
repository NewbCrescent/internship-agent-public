-- Postings whose requirement lines were found but not yet labelled HARD or
-- PREFERRED by the model. While a row exists the posting is not analyzed,
-- prepared, or run automatically; each pipeline pass retries the labels.
CREATE TABLE IF NOT EXISTS requirement_label_holds (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  created_at TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL
);
