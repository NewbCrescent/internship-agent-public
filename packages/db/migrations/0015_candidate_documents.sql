-- Candidate-supplied documents other than resumes (the transcript). Bytes
-- stay in the profile's local data directory; rows keep the kind, checksum,
-- and size. One current document per kind; replacements supersede, never
-- delete, so an upload decision can always name the exact file it sent.
CREATE TABLE IF NOT EXISTS candidate_documents (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('transcript')),
  label TEXT NOT NULL,
  file_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  created_at TEXT NOT NULL,
  superseded_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS candidate_documents_current_kind
  ON candidate_documents(candidate_id, kind)
  WHERE superseded_at IS NULL;
