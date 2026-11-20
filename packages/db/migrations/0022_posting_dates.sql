ALTER TABLE jobs ADD COLUMN publication_json TEXT CHECK (publication_json IS NULL OR json_valid(publication_json));
