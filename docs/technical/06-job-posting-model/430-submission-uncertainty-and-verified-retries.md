**Submission uncertainty and verified retries.**
The Gmail watcher evaluates receipt evidence before general outcome filtering.
`pnpm mail:scan --receipt <run-ref>` checks one pending attempt without sending mail or Discord updates.
The check considers up to 14 days, 300 UIDs and 100 bodies within 45 seconds, and uses existing read-only Gmail access.
A receipt must have explicit receipt language, an applicable trusted sender, and one matching posting and attempt after its recorded attempt time.
The trace stores only a bounded result and, for a trusted receipt, a private proof key.
A trusted receipt resolves the investigation and blocks reopening without manufacturing a browser confirmation or changing application status.
`pipeline:retry --reopen-unsubmitted` still needs positive noncompletion evidence, plus a complete no-match check for the exact attempt from the last 15 minutes.
`pipeline:retry --reopen-unsubmitted --candidate-verdict not-submitted` replaces that evidence with the candidate's own verdict (the candidate's decision, 2026-11-27: "1. retry.") and runs its own fresh receipt check first; a trusted receipt still blocks the reopen.
Ambiguous, truncated and unavailable checks keep the run held.
A SUBMITTED record corrected with `pipeline:retry --correct-submitted --confirm` becomes a failed, unconfirmed attempt with a possible-submission hold, so it is pending for `pnpm mail:scan --receipt` like any other; `--close-unsubmitted` and `--correct-submitted` refuse a run whose receipt check is anything but `absent`.
