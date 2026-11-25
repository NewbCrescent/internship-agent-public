# Workday's page errors were one opaque pause

The Granite Dynamics run (employer-d.wd5.myworkdayjobs.com, 2026-11-20 19:30Z)
created its account, walked, and paused with a single "My Information
(Workday errors)" pause, so the digest showed no real question and Workday's
field errors were not kept. Now `readWorkdayErrors` reads Workday's error
list (`errorMessage`, `inputAlert`, the `errorBanner` items, alerts, with
each inline error's field container and label) and `workdayErrorPauses`
makes one pause per error, "<field label>: <Workday's error text>" on
`<step>::workday-error::<field id>` (or `workday-error-<n>` for an error on
no known field); the banner's repeats add none. An answer fills the field on
the next walk and is never saved to generic question memory. The single
"(Workday errors)" pause remains only when Workday shows no error text. The
Granite errors were never captured, so no recognition or mapping change was
made. Regressions: `workday.test.ts` (`pnpm test:browser-worker:fast`), the
blocked walk in `fixture-run.ts` (`pnpm test:browser:fixture`), the Workday
error case in `run-lifecycle.integration.test.ts`, the Workday case in
`automatic-retry.integration.test.ts`, and `question-answer-memory.test.ts`.
