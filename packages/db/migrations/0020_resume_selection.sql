-- Resume entries are a content library: the candidate chooses which ones the
-- printed resume (and the package bullets that match it) include. Entries
-- left off stay approved content for drafting and application forms. The
-- choice is per entry, not per revision, so toggling never creates a revision.
ALTER TABLE resume_entries ADD COLUMN on_resume INTEGER NOT NULL DEFAULT 1 CHECK (on_resume IN (0, 1));
