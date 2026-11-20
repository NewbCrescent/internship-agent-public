-- Detailed candidate-recorded employer news complements the broad job status.
CREATE TABLE outcome_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('RESPONSE', 'OA', 'SCREEN', 'INTERVIEW', 'FINAL', 'OFFER', 'REJECTED', 'GHOSTED')),
  note TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX outcome_events_job_recorded ON outcome_events(job_id, recorded_at);

-- Preserve the detail already present in older status timelines.
INSERT INTO outcome_events (id, job_id, stage, note, recorded_at)
SELECT id, job_id, to_status, detail, created_at
FROM application_events WHERE to_status IN ('INTERVIEW', 'OFFER', 'REJECTED');

-- Prices are optional snapshots in micro-USD; older calls remain unknown.
ALTER TABLE model_invocations ADD COLUMN source_url TEXT;
ALTER TABLE model_invocations ADD COLUMN estimated_cost_microusd INTEGER CHECK (estimated_cost_microusd >= 0);
CREATE INDEX model_invocations_source_url ON model_invocations(source_url);
