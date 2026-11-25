# Answered automatic runs were never submitted by the auto-submit policy

On 2026-11-24 the candidate answered the last open question of the real
Contoro run `<run id>` (Ashby, started by the pipeline) with
`pnpm run:answer`. The run reached the submit step with no open pause, but
`advancePipeline` called `submitAutomatically` only right after
`startBrowserRun` in the same pass, so a run that became clean later
(through `run:answer`, the application page, or a later pass) waited for a
human approval indefinitely, against the candidate's 2026-11-21 decision that
an application that asked a question should still be submitted
automatically; run:answer also printed that a paused run is never submitted
automatically. Now each pass with the auto-submit policy first takes such
runs (`continuedAutoSubmitRuns`, `packages/agent/src/continued-auto-submit.ts`)
through the same `submitAutomatically` check (target and AI fit, company cap,
graduation profile, daily cap), never a run the candidate started or one
whose submit was approved, attempted, or may have reached the site, and
run:answer prints what happens next. Regression:
`testing-harness/agent/continued-auto-submit.integration.test.ts`
(`pnpm test:agent:continued`).
