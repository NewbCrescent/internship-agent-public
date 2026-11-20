-- Milestone 4: deterministic match reports with explainable reasons.
-- A row is replaced on every evaluation, so the table always reflects the
-- latest posting snapshot, facts, and evidence.
CREATE TABLE IF NOT EXISTS job_matches (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK (verdict IN ('QUALIFIED', 'NOT_QUALIFIED', 'NEEDS_REVIEW')),
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  fit_score INTEGER NOT NULL CHECK (fit_score >= 0 AND fit_score <= 100),
  findings_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  evaluated_at TEXT NOT NULL
);
