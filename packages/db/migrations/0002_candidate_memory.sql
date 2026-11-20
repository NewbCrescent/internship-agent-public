CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  preferred_name TEXT,
  email TEXT,
  phone TEXT,
  school TEXT,
  degree TEXT,
  graduation_date TEXT,
  linkedin_url TEXT,
  github_url TEXT,
  portfolio_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidate_preferences (
  candidate_id TEXT PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
  role_types_json TEXT NOT NULL,
  locations_json TEXT NOT NULL,
  work_modes_json TEXT NOT NULL,
  industries_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidate_facts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('boolean', 'date')),
  source TEXT NOT NULL CHECK (source IN ('user', 'verified_evidence')),
  source_detail_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('standard', 'sensitive', 'protected')),
  reuse_policy TEXT NOT NULL CHECK (reuse_policy IN ('auto', 'confirm', 'never')),
  remembered_at TEXT,
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_id TEXT REFERENCES candidate_facts(id),
  revoked_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS candidate_facts_current_identity
  ON candidate_facts(candidate_id, key, scope_key)
  WHERE superseded_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS candidate_facts_candidate_created
  ON candidate_facts(candidate_id, created_at DESC);
