-- Milestone 5: versioned application packages with their independent
-- verification reports, resume variants with frozen rendered snapshots,
-- and an append-only event log that Milestone 6 renders as a timeline.
CREATE TABLE IF NOT EXISTS application_packages (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  package_json TEXT NOT NULL,
  verification_json TEXT,
  blocked INTEGER CHECK (blocked IN (0, 1)),
  superseded_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS application_packages_current
  ON application_packages(job_id)
  WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS resume_variants (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  bullets_json TEXT NOT NULL,
  rendered_markdown TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS application_events_job_created
  ON application_events(job_id, created_at);
