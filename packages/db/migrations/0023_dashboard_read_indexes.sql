-- Bounded dashboard reads and correlated location/resume lookups.
CREATE INDEX IF NOT EXISTS job_locations_job_span ON job_locations(job_id, span_start);
CREATE INDEX IF NOT EXISTS resume_variants_job_created ON resume_variants(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_created_id ON jobs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS jobs_status_updated ON jobs(status, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS application_events_created ON application_events(created_at DESC);
