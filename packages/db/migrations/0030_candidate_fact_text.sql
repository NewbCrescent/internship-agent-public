-- Candidate facts gain a "text" value type (how the candidate heard about a
-- job, pronouns, saved voluntary self-identification answers). SQLite cannot
-- alter a CHECK constraint, so the table is rebuilt with every row, its two
-- indexes, and the AI-fit context triggers from 0024.
CREATE TABLE candidate_facts_next (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('boolean', 'date', 'text')),
  source TEXT NOT NULL CHECK (source IN ('user', 'verified_evidence')),
  source_detail_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('standard', 'sensitive', 'protected')),
  reuse_policy TEXT NOT NULL CHECK (reuse_policy IN ('auto', 'confirm', 'never')),
  remembered_at TEXT,
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_id TEXT REFERENCES candidate_facts_next(id),
  revoked_at TEXT
);

-- Newest first, so a superseded row's successor already exists when it is copied.
INSERT INTO candidate_facts_next (id, candidate_id, key, scope_json, scope_key, value_json, value_type, source, source_detail_json, confidence, sensitivity, reuse_policy, remembered_at, created_at, superseded_at, superseded_by_id, revoked_at)
  SELECT id, candidate_id, key, scope_json, scope_key, value_json, value_type, source, source_detail_json, confidence, sensitivity, reuse_policy, remembered_at, created_at, superseded_at, superseded_by_id, revoked_at
  FROM candidate_facts ORDER BY created_at DESC;

DROP TABLE candidate_facts;
ALTER TABLE candidate_facts_next RENAME TO candidate_facts;

CREATE UNIQUE INDEX candidate_facts_current_identity
  ON candidate_facts(candidate_id, key, scope_key)
  WHERE superseded_at IS NULL AND revoked_at IS NULL;

CREATE INDEX candidate_facts_candidate_created
  ON candidate_facts(candidate_id, created_at DESC);

CREATE TRIGGER semantic_fit_candidate_facts_insert AFTER INSERT ON candidate_facts BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_candidate_facts_update AFTER UPDATE ON candidate_facts BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_candidate_facts_delete AFTER DELETE ON candidate_facts BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
