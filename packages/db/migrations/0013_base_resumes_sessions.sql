-- Candidate-supplied base resumes and browser sign-in state.
-- Base resume bytes stay in the profile's local data directory; rows keep
-- the channel, checksum, and size. One current resume per channel; older
-- rows are superseded, never deleted, so submitted runs stay traceable.
CREATE TABLE IF NOT EXISTS base_resumes (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('default', 'handshake_internal')),
  label TEXT NOT NULL,
  file_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  created_at TEXT NOT NULL,
  superseded_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS base_resumes_current_channel
  ON base_resumes(candidate_id, channel)
  WHERE superseded_at IS NULL;

-- A run that uploaded a base resume records which one, alongside variant_id.
ALTER TABLE browser_runs ADD COLUMN base_resume_id TEXT REFERENCES base_resumes(id);

-- Last observed sign-in state for the candidate's own browser profile.
-- Only the classification and a short detail are stored: no cookies, URLs
-- with tokens, or page content.
CREATE TABLE IF NOT EXISTS browser_sessions (
  site TEXT PRIMARY KEY CHECK (site IN ('handshake')),
  status TEXT NOT NULL CHECK (status IN ('connected', 'signed_out', 'unknown')),
  detail TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
