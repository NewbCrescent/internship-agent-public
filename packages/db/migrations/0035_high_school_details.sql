-- Track 41 (the candidate's rule, 2026-11-26): the high school's place, entered
-- only by the candidate (pnpm profile:facts' highSchool file), and where the
-- high school's details came from. A profile-page save leaves them as they are.
ALTER TABLE candidates ADD COLUMN high_school_city TEXT;
ALTER TABLE candidates ADD COLUMN high_school_region TEXT;
ALTER TABLE candidates ADD COLUMN high_school_postal_code TEXT;
ALTER TABLE candidates ADD COLUMN high_school_source TEXT;
