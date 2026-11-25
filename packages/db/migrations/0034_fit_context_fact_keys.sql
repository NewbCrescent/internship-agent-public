-- The AI-fit prompt reads only the candidate facts listed in FIT_CONTEXT_FACT_KEYS
-- (packages/domain/src/matching.ts), today only graduation_date. The 0024/0030
-- triggers bumped the fit context version on every fact write, which made every
-- cached AI fit stale after any answer was saved. Keep this key list equal to
-- FIT_CONTEXT_FACT_KEYS; the db suite fails when they differ. A future rebuild of
-- candidate_facts must recreate these filtered triggers. The version is
-- deliberately not bumped here, so fits already scored stay current.
DROP TRIGGER IF EXISTS semantic_fit_candidate_facts_insert;
DROP TRIGGER IF EXISTS semantic_fit_candidate_facts_update;
DROP TRIGGER IF EXISTS semantic_fit_candidate_facts_delete;
CREATE TRIGGER semantic_fit_candidate_facts_insert AFTER INSERT ON candidate_facts
  WHEN NEW.key IN ('graduation_date')
  BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_candidate_facts_update AFTER UPDATE ON candidate_facts
  WHEN NEW.key IN ('graduation_date') OR OLD.key IN ('graduation_date')
  BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER semantic_fit_candidate_facts_delete AFTER DELETE ON candidate_facts
  WHEN OLD.key IN ('graduation_date')
  BEGIN UPDATE semantic_fit_context SET version = version + 1 WHERE id = 1; END;
