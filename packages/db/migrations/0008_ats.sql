-- Milestone 8: ATS classification travels with the run. A run starts with
-- the suggested kind and a confidence; the candidate confirms the kind
-- (or generic explicitly) before submission. Corrections stay visible as
-- application events and never silently change behavior.
ALTER TABLE browser_runs ADD COLUMN ats_kind TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE browser_runs ADD COLUMN ats_confidence REAL NOT NULL DEFAULT 0;
ALTER TABLE browser_runs ADD COLUMN suggested_ats_kind TEXT;
ALTER TABLE browser_runs ADD COLUMN ats_confirmed INTEGER NOT NULL DEFAULT 0;
