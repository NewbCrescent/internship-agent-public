-- Dates and details application forms ask for, entered by the candidate:
-- structured work dates per experience revision (the printed date_text is
-- unchanged and never parsed), plus phone type, field of study, and the
-- month education began. Months are stored as YYYY-MM.
ALTER TABLE resume_entry_revisions ADD COLUMN start_month TEXT;
ALTER TABLE resume_entry_revisions ADD COLUMN end_month TEXT;
ALTER TABLE resume_entry_revisions ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1));
ALTER TABLE candidates ADD COLUMN phone_type TEXT;
ALTER TABLE candidates ADD COLUMN field_of_study TEXT;
ALTER TABLE candidates ADD COLUMN education_start_month TEXT;
