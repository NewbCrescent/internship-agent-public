# A Workday step was saved after reading no fields

Two Workday runs (2026-11-20 and 2026-11-24) planned nothing on My
Information and clicked Save and Continue, so Workday reported the name,
phone, and how-heard fields empty, though the profile and the how-heard rule
answer all of them. The readiness wait counted field containers the step
reader then skipped as not visible, and the walker saved a step from which it
had read no field. The wait now counts only visible field containers, and a
step read with no fields is read once more and never saved past (the walk
stops as blocked, "could not read any field"). The cause (a step drawn
hidden while loading) is inferred from the recorded runs and has not been
confirmed on a live page. Regressions: the two no-field Workday tests in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts`
(`pnpm test:browser-worker:local`) and the synthetic `?hidden=` Workday
fixture in `testing-harness/browser/fixture-run.ts`
(`pnpm test:browser:fixture`).
