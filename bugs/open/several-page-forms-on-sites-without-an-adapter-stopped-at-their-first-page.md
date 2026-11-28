# Several-page forms on sites without an adapter stopped at their first page

The blocker board (`pnpm pipeline:scoreboard --profile real`, 2026-11-27) held four applications only with the several-page stop ("The application at <site> continues over several pages (its button says "<text>"), and the agent fills several-page forms only on sites it has an adapter for.").
Two are Paylocity applications (`recruiting.paylocity.com`, "Next Step", "Step 1 of 5"; see paylocity-applications-span-five-steps.md), one is MITRE's Phenom career site (`careers.mitre.org`, "Next", `step=1&stepname=personalInformation` in the apply page's address), and one is a second Phenom career site ("Next"; its apply page's address was not captured).
No run trace was kept for these runs, and no step after step 1 was ever captured for either site, so no site-specific adapter could be built from evidence.
Track 74 added a generic, conservative stepped walk (`packages/browser/src/stepped-form.ts`, `packages/agent/src/stepped-form-run.ts`): a page that shows its step count is walked step by step with the existing planner, clicking only each step's own Next, pausing on unknowns and on fields the site marks invalid, stopping with a capture on anything it cannot tell is safe, and waiting at the last step for the candidate's approval.
Since Track 80 (2026-11-28) the auto-submit policy submits clean stepped runs too, holding the outcome as a possible submission until a receipt check, and `ATS_KINDS_NEEDING_APPROVAL` is unchanged.
This stays open until a live retry moves these applications past their first page; each stop on a later step saves a capture for a site adapter.
If the second Phenom site's apply page carries no `step=` in its address, the walk does not engage there and today's stop stays.
fixture: modelled

## Refuted causes
- MITRE's several-page form is Workday's own application flow. Evidence: Track 38, run <run id> submit evidence (careers.mitre.org Phenom apply page, step list ending in Review), bugs/resolved/mitres-phenom-form-was-taken-for-workday-and-approved-for-automatic-submission.md.
