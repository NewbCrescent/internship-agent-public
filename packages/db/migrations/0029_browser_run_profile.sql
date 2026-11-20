-- The graduation profile a browser run used: 'default' (the default graduation
-- answer) or 'transcript' (the alternate application-channel profile, used when a
-- form asks for a transcript or the company already received that profile).
-- NULL on runs recorded before this migration; their profile is read from their decisions.
ALTER TABLE browser_runs ADD COLUMN application_profile TEXT
  CHECK (application_profile IS NULL OR application_profile IN ('default', 'transcript'));
