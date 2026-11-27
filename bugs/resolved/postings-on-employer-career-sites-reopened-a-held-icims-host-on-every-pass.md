# Postings on employer career sites reopened a held iCIMS host on every pass

Found on 2026-11-27 (Track 69): postings whose address is on the employer's own careers domain and whose Apply leads to `*.icims.com` were opened again on every pipeline pass although their iCIMS host had a stored CAPTCHA hold, and the pipeline status listed them as `icims:unknown`.
One Garmin posting (<run id>) saved 184 `icims-account` captures from 2026-11-24T23:57Z to 2026-11-27T05:38Z, and a Kimley-Horn posting (<run id>) 174, each one the email step driven again into hCaptcha.
Cause: the pipeline checked the iCIMS host's hold only for the posting address (`icimsHostOf(url)` in `packages/agent/src/pipeline-orchestrator.ts`), which is not an iCIMS host for these postings, so `icimsAccountWait` was never consulted.
Fix: `lastIcimsWaitHost` reads the iCIMS host the job's newest wait named ("Automatic browser run waiting: iCIMS <host>: …"), so a held host opens no browser for such a posting either, and the pipeline reports it under `icims:<host>` (on its first wait, the host is read from the held reason).
Regression: "keeps a posting on the employer's careers site waiting on its held iCIMS host without opening a browser" in `testing-harness/browser-worker/account-consent.integration.test.ts` (`pnpm test:browser-worker:local`).
Not changed: the CAPTCHA itself, which the agent never solves.

fixture: captured 2026-11-27 (the real workspace's wait event text and pipeline-status.json, read-only); hosts fictional

## Refuted causes

- A CAPTCHA hold is retried on purpose every pass. Evidence: icimsAccountWait returns a stored captcha hold's reason (never due), and every posting that kept reopening has a non-iCIMS address (pipeline-status.json 2026-11-27T05:20Z lists them as icims:unknown) while iCIMS-hosted postings on the same holds waited.
