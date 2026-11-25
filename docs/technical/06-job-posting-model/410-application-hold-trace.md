**Application hold trace.**
`pnpm pipeline:audit` remains a read-only snapshot.
`pnpm pipeline:audit --trace <job-or-run-ref>` shows persisted hold transitions, receipt-check results and delivery acknowledgements, with a `run:evidence` command for the underlying local artifact.
The trace stores fixed reason and owner codes, timestamps, references and private fingerprints.
It excludes form contents, email text, URLs, answers and credentials.
The pass, digest, and `pipeline:audit --watch --inject` reconcile one current revision per job or run, including pre-run account stops.
The watcher sends just the changed manager-owned revisions and records delivery after successful injection.
Restarting a watcher preserves acknowledgements.
Distinct destinations have distinct delivery records.
