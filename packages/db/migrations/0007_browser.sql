-- Milestone 7: deterministic browser runs with their fill decisions,
-- candidate pauses, submission approvals, and confirmation records.
-- A SUBMITTED run references the exact verified package and resume
-- variant that were sent, so history stays reconstructible.
CREATE TABLE IF NOT EXISTS browser_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  application_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'started', 'paused-needs-input', 'awaiting-approval',
    'submitting', 'submitted', 'failed', 'cancelled'
  )),
  package_id TEXT NOT NULL REFERENCES application_packages(id),
  variant_id TEXT REFERENCES resume_variants(id),
  decisions_json TEXT NOT NULL,
  pauses_json TEXT NOT NULL,
  submitted_answers_json TEXT,
  confirmation_text TEXT,
  submission_approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS browser_runs_job_updated
  ON browser_runs(job_id, updated_at);
