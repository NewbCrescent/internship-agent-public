# Held runs whose every question was answered were never continued, and the board named their start note

Found 2026-11-27 on the real workspace (Track 78), from board blocker bf8c263b7ef "greenhouse: Browser run started automatically from the verified package" (2 applications, Muon Space).
The Muon Space runs <run id> (Flight Software) and <run id> (Software Engineering-Information Systems) are `paused-needs-input`, ATS confirmed, with no submit approval and no confirmation.
Each had one pause (the U.S. export-control select), and it is answered.
Their timelines end with the run start, the saved run trace, and the stop re-check's event "Answer to … found in your saved answers (a standard answer): … it no longer waits for you." (2026-11-27T00:50:20Z).
CodeRabbit run <run id> (Ashby, blocker bb9e453a74c) and APEX Analytix run <run id> (Rippling, blocker b0c0d2c8ce0) were in the same state with the same start-note label, its last question answered once without a continue: 4 applications in total.

Cause:

1. The stop re-check (`recheckRunPauses` in `packages/agent/src/browser-orchestrator.ts`), like an answer saved without a continue, marks the last open pause answered and leaves the run `paused-needs-input` by design, to be filled by a continue.
   Nothing continued such a run automatically: the pass's sweep `continuedAutoSubmitRuns` takes only `awaiting-approval` runs, and `pnpm pipeline:retry --held` refuses any run with an answered pause; only `pnpm run:answer --continue` moved it.
2. `classifyRunHold` (`packages/agent/src/application-holds.ts`) classifies a paused run with no open pause as `automation-fault`, and `observeApplicationHolds` takes the job's newest status-change event, here the run start, as the hold's source.
   The scoreboard's `stopCause` (`packages/agent/src/pipeline-scoreboard.ts`) printed that event's detail as the stop reason, so the board showed the start note as the blocker.

Fix:

- Each pass now continues a held run the pipeline started whose every question is answered, before the auto-submit sweep, with no voice drafter and no AI review (`answeredHeldRuns` and `answeredContinueBlocker` in `packages/agent/src/continued-auto-submit.ts`, called from `advancePipeline` in `packages/agent/src/pipeline-orchestrator.ts`; the pass logs "continued <job>: <status>" in `packages/agent/scripts/pipeline-pass.ts`).
  A run that reaches the submit step goes through the unchanged `submitAutomatically` check in the same pass.
  A failed continue is logged "Automatic browser run failed: the answered run could not be continued: <reason>" and is not tried again until the run changes.
  Runs the candidate started, Workday runs, runs with a safeguard pause, a submit approval, post-submit evidence, or a possible-submission hold, skipped or relabel-held postings, and runs whose package changed are not continued.
- The board names a run's stop only from a stop or hold event, never from a start, restart, or retry note; without one, a paused run whose every question is answered shows "<ATS>: all questions answered; the run waits to be continued", another paused run "<ATS>: paused with no open question", and a failed run "<ATS>: browser run failed".

Regressions: the "answered held runs (Track 78)" cases in `testing-harness/agent/continued-auto-submit.integration.test.ts` (`pnpm test:agent:continued`) and "names a held run's stop only from a stop or hold event, never its start note (Track 78)" in `testing-harness/agent/pipeline-scoreboard.integration.test.ts` (`pnpm test:agent:scoreboard`).
Not verified live: the continue of the four runs on their real boards, which the first pass after the merge performs.

fixture: captured 2026-11-27 (the stored run states and timelines of runs <run id>, <run id>, <run id> and <run id>, read read-only; the test fixtures are synthetic; the live continue on the real boards is confirmed by the first pass after the merge)

## Refuted causes

- The runs crashed or timed out mid-run with no stop reason recorded. Evidence: runs <run id> and <run id> are paused-needs-input, not failed; each saved its run trace (2026-11-26T23:20:33Z, 23:16:10Z) and has no failure event; the hold is automation-fault because classifyRunHold maps a paused run with no open pause to it (read-only real-DB query, 2026-11-27).
- A run stuck in a running or started state that is never closed. Evidence: no run of either job is submitting or running; both were last updated at 2026-11-27T00:50:20Z by the stop re-check event "found in your saved answers (a standard answer)".
- A Greenhouse-specific failure. Evidence: Ashby run <run id> (CodeRabbit) and Rippling run <run id> (APEX Analytix) are in the same state with the same start-note label (board blockers bb9e453a74c, b0c0d2c8ce0, 2026-11-27).
- They only need a requeue with pipeline:retry --held. Evidence: retryAutomaticRun refuses any run with an answered pause (docs/technical/06-job-posting-model/170), so --held skips them.
