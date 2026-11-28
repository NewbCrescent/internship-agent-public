# Greenhouse applications that careers pages draw only after cookies are accepted were never reached

Found 2026-11-27 in Track 77's triage of the "The application site type was not recognized automatically" blocker (b096af2a79d), on Amperity's run <run id> (`amperity.com/careers?gh_jid=8393990#openpositions`).
Amperity adds Greenhouse's embed script (`boards.greenhouse.io/embed/job_board/js?for=amperity`, `#grnhse_app`) only when its Cookiebot "preferences" and "statistics" cookies are accepted (chunk `469.ce9cda20e84fdd6c.js`; otherwise "This content requires preferences and statistics cookies to be enabled").
The agent rejects cookies and never accepts them, so no embed was ever on the page, and `greenhouseEmbedTarget`, which reads the board only from the page, could not fire.
Fix: before a generic run opens its page, `findGreenhouseEmbed` (`packages/agent/src/greenhouse-embed-board.ts`, called by `startBrowserRun`) asks Greenhouse's public board API about an employer page's `gh_jid` job, for the boards the company name and the host name (`greenhouseBoardSlugs`, the same rule ingestion uses).
The board counts only when Greenhouse lists the same job id with an `absolute_url` on the same host carrying the same `gh_jid`, and the embed `job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>` answers 200 without a redirect; the run then opens and saves that embed and logs the board on the timeline, and otherwise opens the employer page as before.
Read-only checks on 2026-11-27: Amperity's job 8393990 is on the `amperity` board with that page as its address, its embed answers 200, and the embed's page data names `/embed/job_app/confirmation?for=amperity&token=8393990` as its confirmation address, which `isConfirmationUrl` reads; 16 of the 17 companies with active gh_jid jobs check out the same way (Zipline's job answered 404 and keeps today's path).
Regression: the `findGreenhouseEmbed (Track 77)` cases in `testing-harness/jobs/posting-sources.test.ts` (`pnpm test:jobs:fast`) and the Track 77 cases in `testing-harness/browser-worker/run-lifecycle.integration.test.ts` (`pnpm test:browser-worker:local`).
fixture: captured 2026-11-27 (Greenhouse's board API and embed responses, read only)

## Refuted causes

- Amperity's page embeds a Greenhouse application the walker missed. Evidence: the static careers page and its job page carry no Greenhouse address; chunk 469.ce9cda20e84fdd6c.js adds the embed script only with preferences and statistics cookies.
