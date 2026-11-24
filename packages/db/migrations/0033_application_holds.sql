CREATE TABLE application_holds (
  hold_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES browser_runs(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  owner TEXT NOT NULL CHECK (owner IN ('manager', 'candidate')),
  reason TEXT NOT NULL CHECK (reason IN ('possible-submission', 'account-stop', 'automation-fault', 'form-review', 'candidate-question', 'manual-challenge', 'manual-field-correction', 'approval')),
  identity TEXT NOT NULL,
  evidence_ref TEXT,
  source_event_id TEXT,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE application_hold_events (
  id INTEGER PRIMARY KEY,
  hold_key TEXT NOT NULL REFERENCES application_holds(hold_key) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('opened', 'changed', 'resolved', 'reopened', 'verified-retry', 'reopened-unsubmitted', 'receipt-check')),
  owner TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_ref TEXT,
  source_event_id TEXT,
  action_ref TEXT,
  receipt_result TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX application_hold_events_key ON application_hold_events(hold_key, id);

CREATE TABLE application_hold_delivery (
  hold_key TEXT NOT NULL REFERENCES application_holds(hold_key) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (hold_key, revision, recipient)
);

CREATE TABLE application_receipt_checks (
  run_id TEXT PRIMARY KEY REFERENCES browser_runs(id) ON DELETE CASCADE,
  result TEXT NOT NULL CHECK (result IN ('confirmed', 'absent', 'ambiguous', 'truncated', 'unavailable')),
  proof_ref TEXT,
  attempted_at TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE TABLE application_hold_retries (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  fix_ref TEXT NOT NULL,
  evidence_identity TEXT NOT NULL,
  PRIMARY KEY (job_id, fix_ref, evidence_identity)
);
