-- Structured resume content. Entries are stable; every edit is a new
-- revision and the previous one is superseded, never deleted, so a frozen
-- resume snapshot can always name the exact revision it printed.
-- Candidate-typed revisions are APPROVED on save; revisions transcribed
-- from a base resume stay PENDING until the candidate approves them.
ALTER TABLE candidates ADD COLUMN gpa TEXT;

CREATE TABLE IF NOT EXISTS resume_entries (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  section TEXT NOT NULL CHECK (section IN ('experience', 'project', 'skills')),
  position INTEGER NOT NULL CHECK (position >= 0),
  archived_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS resume_entries_candidate_section
  ON resume_entries(candidate_id, section, position);

CREATE TABLE IF NOT EXISTS resume_entry_revisions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES resume_entries(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  role TEXT,
  link_label TEXT,
  link_url TEXT,
  location TEXT,
  date_text TEXT,
  bullets_json TEXT NOT NULL,
  source_json TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK (review_status IN ('PENDING', 'APPROVED')),
  approved_at TEXT,
  created_at TEXT NOT NULL,
  superseded_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS resume_entry_revisions_current
  ON resume_entry_revisions(entry_id)
  WHERE superseded_at IS NULL;

-- The frozen structured resume a variant prints from.
ALTER TABLE resume_variants ADD COLUMN document_json TEXT;
