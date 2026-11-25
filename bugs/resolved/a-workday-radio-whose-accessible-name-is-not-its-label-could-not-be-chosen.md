# A Workday radio whose accessible name is not its label could not be chosen

Found 2026-11-25 on the real workspace, in pass 13. Example
Nonprofit's "Have you previously been employed by Example
Nonprofit?" (employer-e.wd5, run <run id>) was mapped and answered from
the saved answer, but the fill failed: "The agent could not fill …: the
page did not accept the value." The cause is not confirmed: no form-step DOM
was captured. The Workday adapter chose a radio with Playwright's
`getByLabel(option, { exact: true })`, which reads the accessible name,
while the form is read by each radio's `label[for]` text; a radio labelled
by its question (aria-labelledby) has the question as its accessible name,
so the planned option is not found. Fix (hardening): `chooseWorkdayRadio`
(`packages/browser/src/ats/workday.ts`) finds the one radio whose label
read as `collectWorkdayControlsIn` reads it (`label[for]` text, else
aria-label, else value) is the planned option, checks it, else clicks it
through its label (else a dispatched click), and reads it back for up to
2 s; no match, several matches, or a choice the page did not keep pauses
with that plain reason, never echoing the option. Regression: the `?gaps=1`
previous-worker radios of
`testing-harness/browser/fixtures/workday-application.html` are labelled by
their question, and `testing-harness/browser/fixture-run.ts` checks the
choice reads No (`xvfb-run -a pnpm test:browser:fixture`); with the old
lookup the walk pauses on that radio. Not verified live: Compassion's real
radio markup is unknown.
