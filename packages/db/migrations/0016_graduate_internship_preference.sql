-- Candidate-owned matching preference, separate in each workspace database.
ALTER TABLE candidate_preferences
  ADD COLUMN exclude_graduate_only_internships INTEGER NOT NULL DEFAULT 0
  CHECK (exclude_graduate_only_internships IN (0, 1));
