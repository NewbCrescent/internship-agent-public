# A value Workday already showed held automatic submission as a kept attachment

Found 2026-11-25 on the real workspace: every Workday run with a shown
Country or Country Phone Code (ZOLL's pass log among them) was held with
"The site kept an attachment you need to confirm." Cause:
`autoSubmitBlockers` counted every `keep` decision as a kept attachment,
and the planner records a field's shown value as a keep. The planner now
gives a shown value one of two reasons: `SITE_VALUE_KEPT_REASON` when no
saved answer of the candidate's applies to the question, which no longer
holds the run, and `UNCONFIRMED_SITE_VALUE_REASON` when the catalog
recognized the question but nothing saved settles it (no saved fact, needs
confirmation, ambiguous, or a saved answer that is not one of the
options), which holds it as "The site already shows an answer that none of
your saved answers confirms". Runs planned before this change keep the old
reason and stay held; any other keep (Handshake's attached resume) holds as
an attachment as before. Regressions:
`testing-harness/domain/submission-mode.test.ts` (`pnpm test:domain`) and
the keep-reason cases in `testing-harness/browser-worker/self-identification.test.ts`
(`pnpm test:browser-worker:fast`). Runs already waiting with the old
reason need a fresh run to benefit.
