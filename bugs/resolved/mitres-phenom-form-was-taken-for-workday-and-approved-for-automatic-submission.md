# MITRE's Phenom form was taken for Workday and approved for automatic submission

On run <run id> (2026-11-25) MITRE's Phenom apply step 1, on MITRE's own careers site, was recognized as Workday at 0.75 from a "Careers" page title and a sentence telling internal employees to apply "through Workday"; cancelled run <run id> had the same misclassification.
The confidence was in the automatic band, so the kind was confirmed without the candidate, and the several-page stop was skipped because the flow was automatic.
Only the first step was filled, and the auto-submit policy approved the run; the submit click failed and nothing was sent.
Fix: a kind reaches the automatic band only on its own site or with its embed marker (`atsKindOwnsUrl`, `packages/domain/src/ats.ts`); elsewhere it is capped at 0.55 for the candidate to confirm, and Workday off its own host is not Workday at all.
Workday's bare "workday" URL pattern and "careers" title pattern are gone, and a several-page kind is never automatic in the generic path, so the several-page stop applies.
Under the auto-submit policy a run whose page and recorded address are both off the recognized kind's site is held before anything is typed (`claimedSiteHoldReason`, `packages/browser/src/submit-gate.ts`).
Regressions: scenario (i) of `pnpm test:browser:unrecognized-forms`, the "site ownership" cases in `pnpm test:browser-worker:fast`, and the Track 38 automatic-submission cases in `pnpm test:browser-worker:local`.
