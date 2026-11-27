# An iCIMS career site's newsletter box was read as the application form

Found on 2026-11-27 (Track 69) on Harvard Companies (job <run id>, run <run id>) and Harvard Maintenance (job <run id>, run <run id>): every run was saved at the posting address `/jobs/41029/job` on the employer's `*.icims.com` host, with only two decisions, the site search box `s` skipped and a third-party newsletter email box `email-<form id>` filled with the profile email, and each waited for the candidate's approval as an iCIMS application.
Cause: an email box is a known field, so the start (`packages/agent/src/browser-orchestrator.ts`, around line 918) never followed the posting's Apply entry, and `hasApplicationFields` kept the site walker off; the career-site wrapper's boxes were read as the form.
Fix: `icimsPostingPage` (`packages/browser/src/apply-entry.ts`) tells an iCIMS posting page (`/jobs/<number>/job` or `/jobs/<number>/<slug>/job` with no `mode` parameter, so not its `mode=apply` address), and `recognizeCurrentForm` (`packages/browser/src/handshake-executor.ts`) reads no field there, so the posting's Apply entry is followed and iCIMS's account step is handled as usual; with no Apply entry the run stops with "No application form was found" and saves no run.
Regression: `testing-harness/browser-worker/standing-consent.test.ts` (`pnpm test:browser-worker:fast`) and the two iCIMS posting-page cases in "posting pages behind an Apply link" of `testing-harness/browser-worker/run-lifecycle.integration.test.ts` (`pnpm test:browser-worker:local`).
It stays open until a live run on a requeued Harvard job stops at iCIMS's account step instead of waiting for approval.

fixture: modelled (no capture of the Harvard page exists, since a clean awaiting-approval run keeps no trace; the stored decisions and URLs were read read-only; names and hosts in the fixtures are fictional)

## Refuted causes

- The Harvard runs reached iCIMS's application after an account step. Evidence: browser_runs <run id> and <run id> (2026-11-27) are saved at /jobs/41029/job, and neither job has an iCIMS account event.
- The email box was iCIMS's own email-first step. Evidence: that step is served at the /login path (applicationWallKind), both runs were saved at the posting's /job path, and the box's id is a third-party form's `email-<form id>`, identical on both hosts.
