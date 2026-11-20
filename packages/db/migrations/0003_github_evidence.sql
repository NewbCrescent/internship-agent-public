CREATE TABLE IF NOT EXISTS github_repositories (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  description TEXT,
  observed_head_sha TEXT,
  analyzed_head_sha TEXT,
  sync_status TEXT NOT NULL CHECK (sync_status IN ('IDLE', 'SYNCING', 'SYNCED', 'FAILED')),
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(candidate_id, owner, name)
);

CREATE TABLE IF NOT EXISTS repository_files (
  repository_id TEXT NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('readme', 'manifest', 'source')),
  last_seen_sha TEXT NOT NULL,
  PRIMARY KEY(repository_id, path)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL UNIQUE REFERENCES github_repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('repository_metadata', 'readme', 'manifest', 'source')),
  commit_sha TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL CHECK (start_line >= 1),
  end_line INTEGER NOT NULL CHECK (end_line >= start_line),
  source_url TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  excerpt_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'technology', 'skill', 'metric')),
  normalized_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, kind, normalized_key)
);

CREATE TABLE IF NOT EXISTS claim_revisions (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK (review_status IN ('PENDING', 'ALLOWED', 'QUESTIONED', 'REJECTED')),
  freshness TEXT NOT NULL CHECK (freshness IN ('CURRENT', 'STALE')),
  evidence_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS claim_revisions_current
  ON claim_revisions(claim_id)
  WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS claim_evidence (
  claim_revision_id TEXT NOT NULL REFERENCES claim_revisions(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence_items(id) ON DELETE CASCADE,
  PRIMARY KEY(claim_revision_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS claim_review_events (
  id TEXT PRIMARY KEY,
  claim_revision_id TEXT NOT NULL REFERENCES claim_revisions(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('ALLOWED', 'QUESTIONED', 'REJECTED')),
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS evidence_repository_path
  ON evidence_items(repository_id, path, commit_sha);

CREATE INDEX IF NOT EXISTS claim_project_kind
  ON claims(project_id, kind);
