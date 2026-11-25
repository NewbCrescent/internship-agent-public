# Runs that never reached an application form waited at the submit step

On 2026-11-24 three automatic runs, on an Oracle Cloud HCM posting, a
SmartRecruiters posting, and a Paylocity posting, reached `awaiting-approval`
with only skip decisions: the controls read there were an Oracle share
widget's copy-link box, a SmartRecruiters share dialog's box with neither id
nor name, and a OneTrust cookie preference panel's toggles and vendor search.
Cause: `startBrowserRun` treated any control of a known kind as a form, so the
posting's Apply entry was never followed and the automatic no-form stop never
fired; the planner skipped every control, and a run with nothing filled and
no pause was saved as waiting at the submit step. `continueBrowserRun` saved
the same shape, and `submitBrowserRun` reopened the address and clicked
submit even when none of the approved fields was on the page. Fix: a run
whose decisions fill, choose, check, upload, keep, or pause nothing stops
with "No application form was reached at <url>: …" (automatic runs as a
recorded stop), saving nothing and leaving the job status unchanged; a
continue that fills nothing and has nothing left to ask keeps the run paused;
a submit whose page shows none of the approved fields clicks nothing and
keeps the approval. Cookie-consent managers' controls, share and copy-link
boxes, and honeypot text boxes are no longer read as fields
(`collectControlsIn`), so the Apply entry and the new site navigation are
tried on such pages. Regressions: "runs that never reached an application
form" in `testing-harness/browser-worker/run-lifecycle.integration.test.ts`
(`pnpm test:browser-worker:local`) and the consent scenarios in
`testing-harness/browser/site-navigation-run.ts`
(`pnpm test:browser:site-navigation`). Runs already saved in that state are
not changed.
