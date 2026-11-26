-- Recorded question wordings: each exact wording a stop asked, recorded
-- against the saved answer it was matched to (a candidate fact by key and
-- scope key, or a question-memory answer by its question key), with the ATS
-- kind and the options the field offered. Written when the candidate saves an
-- answer from a held run, when the stop re-check matches a stop to an
-- already-saved answer, and when the AI review of a pause batch matches one
-- (packages/agent/src/pause-recheck.ts, pause-review.ts). It stores no answer
-- value and never widens a fact's scope; answers used for one run only record
-- nothing. No AI-fit trigger: the AI fit and voice drafting never read it.
CREATE TABLE IF NOT EXISTS candidate_question_aliases (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  wording TEXT NOT NULL CHECK (length(wording) BETWEEN 1 AND 300),
  wording_key TEXT NOT NULL CHECK (length(wording_key) BETWEEN 1 AND 1000),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('fact', 'question')),
  fact_key TEXT,
  fact_scope_key TEXT,
  question_key TEXT,
  ats_kind TEXT NOT NULL CHECK (length(ats_kind) BETWEEN 1 AND 40),
  field_kind TEXT,
  options_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL CHECK (source IN ('candidate_answer', 'saved_answer_match', 'ai_review')),
  source_run_id TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  revoked_at TEXT,
  CHECK ((target_kind = 'fact' AND fact_key IS NOT NULL AND fact_scope_key IS NOT NULL AND question_key IS NULL)
      OR (target_kind = 'question' AND question_key IS NOT NULL AND fact_key IS NULL AND fact_scope_key IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_question_aliases_current
  ON candidate_question_aliases(candidate_id, wording, target_kind, IFNULL(fact_key, ''), IFNULL(fact_scope_key, ''), IFNULL(question_key, ''), ats_kind)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS candidate_question_aliases_key
  ON candidate_question_aliases(candidate_id, wording_key) WHERE revoked_at IS NULL;
