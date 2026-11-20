-- Milestone 9: discovery sources with their rate limits, and a run
-- record per bulk pass so volume stays accountable: fetched, deduped,
-- ingested, analyzed, promoted.
CREATE TABLE IF NOT EXISTS discovery_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('manual-batch', 'company-page')),
  label TEXT NOT NULL,
  url TEXT,
  rate_limit_per_minute INTEGER NOT NULL CHECK (rate_limit_per_minute >= 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES discovery_sources(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  fetched INTEGER NOT NULL,
  deduped INTEGER NOT NULL,
  ingested INTEGER NOT NULL,
  analyzed INTEGER NOT NULL,
  promoted INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS discovery_runs_started
  ON discovery_runs(started_at);
