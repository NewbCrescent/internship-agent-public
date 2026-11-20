CREATE TABLE semantic_fit_context (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
INSERT INTO semantic_fit_context VALUES (1, 0);
CREATE TABLE semantic_fit_job_inputs (job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, version INTEGER NOT NULL);
CREATE TABLE semantic_fit_cache (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL, context_version INTEGER NOT NULL, requirement_version INTEGER NOT NULL,
  assessment_json TEXT NOT NULL, score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100)
);
ALTER TABLE job_matches ADD COLUMN scoring_version INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER semantic_fit_candidates_insert AFTER INSERT ON candidates BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_candidates_update AFTER UPDATE ON candidates BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_candidates_delete AFTER DELETE ON candidates BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_candidate_preferences_insert AFTER INSERT ON candidate_preferences BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_candidate_preferences_update AFTER UPDATE ON candidate_preferences BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_candidate_preferences_delete AFTER DELETE ON candidate_preferences BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_candidate_facts_insert AFTER INSERT ON candidate_facts BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_candidate_facts_update AFTER UPDATE ON candidate_facts BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_candidate_facts_delete AFTER DELETE ON candidate_facts BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_resume_entries_insert AFTER INSERT ON resume_entries BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_resume_entries_update AFTER UPDATE ON resume_entries BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_resume_entries_delete AFTER DELETE ON resume_entries BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_resume_entry_revisions_insert AFTER INSERT ON resume_entry_revisions BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_resume_entry_revisions_update AFTER UPDATE ON resume_entry_revisions BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_resume_entry_revisions_delete AFTER DELETE ON resume_entry_revisions BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_claims_insert AFTER INSERT ON claims BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_claims_update AFTER UPDATE ON claims BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_claims_delete AFTER DELETE ON claims BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_claim_revisions_insert AFTER INSERT ON claim_revisions BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_claim_revisions_update AFTER UPDATE ON claim_revisions BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_claim_revisions_delete AFTER DELETE ON claim_revisions BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_claim_review_events_insert AFTER INSERT ON claim_review_events BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_claim_review_events_update AFTER UPDATE ON claim_review_events BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_claim_review_events_delete AFTER DELETE ON claim_review_events BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_evidence_items_insert AFTER INSERT ON evidence_items BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_evidence_items_update AFTER UPDATE ON evidence_items BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_evidence_items_delete AFTER DELETE ON evidence_items BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_requirements_insert AFTER INSERT ON job_requirements BEGIN
  INSERT INTO semantic_fit_job_inputs(job_id, version) SELECT NEW.job_id, 1 WHERE EXISTS (SELECT 1 FROM jobs WHERE id = NEW.job_id)
  ON CONFLICT(job_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER semantic_fit_requirements_update AFTER UPDATE ON job_requirements BEGIN
  INSERT INTO semantic_fit_job_inputs(job_id, version) SELECT NEW.job_id, 1 WHERE EXISTS (SELECT 1 FROM jobs WHERE id = NEW.job_id)
  ON CONFLICT(job_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER semantic_fit_requirements_delete AFTER DELETE ON job_requirements BEGIN
  INSERT INTO semantic_fit_job_inputs(job_id, version) SELECT OLD.job_id, 1 WHERE EXISTS (SELECT 1 FROM jobs WHERE id = OLD.job_id)
  ON CONFLICT(job_id) DO UPDATE SET version = version + 1;
END;

CREATE TABLE semantic_fit_failures (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
 failed_at TEXT NOT NULL, context_version INTEGER NOT NULL, requirement_version INTEGER NOT NULL, snapshot_id TEXT
);

CREATE TRIGGER semantic_fit_claim_links_insert AFTER INSERT ON claim_evidence BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_claim_links_delete AFTER DELETE ON claim_evidence BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_claim_links_update AFTER UPDATE ON claim_evidence BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
