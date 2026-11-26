-- Track 52: imported public boards and their polling health. Provenance says
-- where an imported board came from; the failure columns back a missing or
-- failing board off instead of retrying it every pass.
ALTER TABLE discovery_sources ADD COLUMN imported_from TEXT;
ALTER TABLE discovery_sources ADD COLUMN imported_at TEXT;
ALTER TABLE discovery_sources ADD COLUMN evidence_url TEXT;
ALTER TABLE discovery_sources ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discovery_sources ADD COLUMN last_error TEXT;
ALTER TABLE discovery_sources ADD COLUMN retry_after TEXT;
