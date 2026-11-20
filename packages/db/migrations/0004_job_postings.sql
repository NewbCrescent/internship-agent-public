-- Milestone 0 created `jobs` with a four-state CHECK constraint. SQLite cannot
-- alter a CHECK constraint, so the table is rebuilt once here with the full
-- application state machine rather than again in a later milestone.

CREATE TABLE jobs_next (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  title TEXT NOT NULL,
  employment_type TEXT NOT NULL CHECK (employment_type IN ('INTERNSHIP', 'CO_OP', 'NEW_GRAD', 'OTHER')),
  application_type TEXT NOT NULL CHECK (application_type IN ('HANDSHAKE_INTERNAL', 'EXTERNAL_ATS', 'EMPLOYER_SITE', 'UNKNOWN')),
  source_url TEXT NOT NULL UNIQUE,
  external_application_url TEXT,
  company_careers_url TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'DISCOVERED', 'ANALYZING', 'NOT_QUALIFIED', 'QUALIFIED', 'PREPARING',
    'NEEDS_INPUT', 'READY_FOR_REVIEW', 'APPROVED', 'APPLYING', 'SUBMITTED',
    'INTERVIEW', 'REJECTED', 'OFFER', 'WITHDRAWN'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO jobs_next (
  id, company_name, title, employment_type, application_type,
  source_url, external_application_url, company_careers_url,
  status, created_at, updated_at
)
SELECT
  id, company_name, title, 'INTERNSHIP', 'UNKNOWN',
  source_url, NULL, NULL,
  status, created_at, created_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_next RENAME TO jobs;

-- The immutable captured posting text. Re-ingesting identical content is a
-- no-op; changed content appends a new snapshot and supersedes the prior one.
CREATE TABLE IF NOT EXISTS job_snapshots (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  superseded_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS job_snapshots_current
  ON job_snapshots(job_id)
  WHERE superseded_at IS NULL;

-- Derived rows below are re-derived from the current snapshot on every
-- accepted ingestion, so they carry no independent review state.
CREATE TABLE IF NOT EXISTS job_locations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  raw TEXT NOT NULL,
  city TEXT,
  region TEXT,
  country_code TEXT,
  work_mode TEXT NOT NULL CHECK (work_mode IN ('ONSITE', 'HYBRID', 'REMOTE', 'UNSPECIFIED')),
  span_start INTEGER NOT NULL CHECK (span_start >= 0),
  span_end INTEGER NOT NULL CHECK (span_end > span_start),
  span_excerpt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_compensation (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  raw TEXT NOT NULL,
  minimum REAL,
  maximum REAL,
  currency TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('HOUR', 'MONTH', 'YEAR', 'STIPEND')),
  span_start INTEGER NOT NULL CHECK (span_start >= 0),
  span_end INTEGER NOT NULL CHECK (span_end > span_start),
  span_excerpt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_requirements (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('HARD', 'PREFERRED')),
  subject TEXT NOT NULL CHECK (subject IN (
    'DEGREE', 'GRADUATION', 'AUTHORIZATION', 'LOCATION',
    'AVAILABILITY', 'SKILL', 'EXPERIENCE', 'OTHER'
  )),
  extraction TEXT NOT NULL CHECK (extraction IN ('DETERMINISTIC', 'MODEL')),
  assertion TEXT NOT NULL CHECK (assertion IN ('STATED', 'INFERRED')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  span_start INTEGER NOT NULL CHECK (span_start >= 0),
  span_end INTEGER NOT NULL CHECK (span_end > span_start),
  span_excerpt TEXT NOT NULL,
  -- Mirrors the domain invariant: an inferred reading may never be hard.
  CHECK (category <> 'HARD' OR assertion = 'STATED')
);

CREATE TABLE IF NOT EXISTS job_technologies (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  normalized_key TEXT NOT NULL,
  label TEXT NOT NULL,
  extraction TEXT NOT NULL CHECK (extraction IN ('DETERMINISTIC', 'MODEL')),
  span_start INTEGER NOT NULL CHECK (span_start >= 0),
  span_end INTEGER NOT NULL CHECK (span_end > span_start),
  span_excerpt TEXT NOT NULL,
  PRIMARY KEY(job_id, normalized_key)
);

-- One row per stated constraint. A posting that is silent about a constraint
-- has no row, which stays distinguishable from a stated negative value.
CREATE TABLE IF NOT EXISTS job_constraints (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('graduation', 'authorization', 'sponsorship', 'availability')),
  raw TEXT NOT NULL,
  detail TEXT NOT NULL,
  extraction TEXT NOT NULL CHECK (extraction IN ('DETERMINISTIC', 'MODEL')),
  assertion TEXT NOT NULL CHECK (assertion = 'STATED'),
  span_start INTEGER NOT NULL CHECK (span_start >= 0),
  span_end INTEGER NOT NULL CHECK (span_end > span_start),
  span_excerpt TEXT NOT NULL,
  PRIMARY KEY(job_id, kind)
);

-- Cost attribution, so a later budget surface can total spend per job.
CREATE TABLE IF NOT EXISTS model_invocations (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('cheap', 'standard', 'frontier')),
  model TEXT NOT NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS job_requirements_job_category
  ON job_requirements(job_id, category);

CREATE INDEX IF NOT EXISTS model_invocations_job
  ON model_invocations(job_id, created_at);
