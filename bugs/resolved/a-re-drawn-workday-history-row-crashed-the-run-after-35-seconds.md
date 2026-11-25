# A re-drawn Workday history row crashed the run after 35 seconds

Found 2026-11-25 on the real workspace, in pass 16. The automatic run on
zoll.wd5 (job <run id>, started 13:55Z on the saved draft) failed before
a run row was saved with "locator.focus: Timeout 30000ms exceeded" on
education row 1's Degree button
(`[data-ia-section="education"] [data-ia-panel="0"] ... degree`); the
call log has no "locator resolved to" line, so the control stopped
resolving for the whole wait. Cause: the history filler finds rows by
the section and panel tags it adds to the page, and re-tags only after a
list pick. When Workday re-draws a row (what re-drew it was not
captured), the tags vanish; the Degree click then waited 5 s and its
fallback `focus()` had no timeout of its own, so the run stopped after
about 35 s instead of re-finding the row or asking. Fix: each history
row field first closes any open list and re-tags the sections, a plain
text entry re-tags too, the fallback focus and the list reads are
bounded, and a control that still does not respond is retried once and
then becomes that row's question
(`packages/browser/src/ats/workday-history.ts`,
`packages/browser/src/ats/workday-lists.ts`). Regression: the
`?school=text&remount=1` "workday re-drawn education row" scenario in
`testing-harness/browser/fixture-run.ts` (`pnpm test:browser:fixture`),
where Escape re-draws every My Experience row.
