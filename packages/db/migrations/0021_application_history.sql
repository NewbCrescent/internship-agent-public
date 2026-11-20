-- Application education and work history (Workday's My Experience). The
-- candidate's high school is entered on the profile; the college row comes
-- from the existing school, degree, and graduation fields. Experience entries
-- join the application work history only when the candidate includes them,
-- independent of whether they print on the resume.
ALTER TABLE candidates ADD COLUMN high_school_name TEXT;
ALTER TABLE candidates ADD COLUMN high_school_start_year TEXT;
ALTER TABLE candidates ADD COLUMN high_school_end_year TEXT;
ALTER TABLE resume_entries ADD COLUMN in_work_history INTEGER NOT NULL DEFAULT 0 CHECK (in_work_history IN (0, 1));
