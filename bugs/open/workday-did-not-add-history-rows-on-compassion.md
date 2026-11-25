# Workday did not add history rows on compassion

Found 2026-11-25 on the real workspace, in pass 16. On employer-e.wd5
(run <run id>, the first Compassion run to reach My Experience) every
history row paused with "Workday did not add a Work Experience row" or
"... an Education row", and no other field of the step (skills, resume,
websites) was read. History pauses save no Workday evidence, and no DOM
was captured. Hypothesis (unconfirmed): the heading walk-up stopped only
at an ancestor holding a button whose whole text is "Add" or "Add
Another"; if a section's Add carries more text (visually hidden section
name), both headings reach a common ancestor holding another section's
plain Add (Websites), that one element is tagged for both kinds, the
work rows find no section, the education Add is the Websites Add, and
every field of the step sits inside a tagged section. Hardening shipped
(Track 36, `packages/browser/src/ats/workday-history.ts`): sections are
found first as Workday's `role="group"` labelled "Work Experience" or
"Education", an Add is Workday's `add-button` whatever its text, one
element is never tagged for both sections, and an Add that shows no row
within 8 s is clicked once more. Regression: the `?sections=aria`
"workday aria sections" scenario in
`testing-harness/browser/fixture-run.ts` (`pnpm test:browser:fixture`).
Still needed: a live Compassion run after this fix to confirm the cause,
and Workday evidence (a screenshot and the section markup) saved for
history-row pauses, which today save none.
