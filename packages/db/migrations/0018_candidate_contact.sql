-- Contact details application forms ask for, entered by the candidate on the
-- profile page and never inferred (a full name is not split into parts).
ALTER TABLE candidates ADD COLUMN legal_first_name TEXT;
ALTER TABLE candidates ADD COLUMN legal_last_name TEXT;
ALTER TABLE candidates ADD COLUMN address_line1 TEXT;
ALTER TABLE candidates ADD COLUMN address_line2 TEXT;
ALTER TABLE candidates ADD COLUMN address_city TEXT;
ALTER TABLE candidates ADD COLUMN address_region TEXT;
ALTER TABLE candidates ADD COLUMN address_postal_code TEXT;
ALTER TABLE candidates ADD COLUMN address_country TEXT;
