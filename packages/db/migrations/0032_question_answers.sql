-- Question memory: the candidate's own answers to application questions outside
-- the fact catalog ("Do you have experience with Python?"), keyed by the
-- normalized question text (normalizeQuestionText in packages/domain) and matched
-- exactly, never fuzzily. Written only when the candidate answers a held run's
-- question and keeps it; company-specific, why/interest, protected, attestation,
-- sensitive, essay, and upload questions are never stored. Append-only by revision
-- like candidate_facts. No AI-fit trigger: the AI fit and voice drafting never read it.
CREATE TABLE IF NOT EXISTS candidate_question_answers (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL CHECK (length(question_key) BETWEEN 1 AND 1000),
  question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 300),
  answer_kind TEXT NOT NULL CHECK (answer_kind IN ('text', 'option')),
  answer TEXT NOT NULL CHECK (length(answer) BETWEEN 1 AND 200),
  answer_key TEXT NOT NULL CHECK (length(answer_key) BETWEEN 1 AND 1000),
  source_run_id TEXT,
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_id TEXT REFERENCES candidate_question_answers(id),
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_question_answers_current
  ON candidate_question_answers(candidate_id, question_key)
  WHERE superseded_at IS NULL AND revoked_at IS NULL;
