# A hidden Workday resume input was read as a field on the next step

Found 2026-11-25 on the real workspace, in pass 16. On littelfuse.wd1
(run <run id>) My Experience was saved with its resume, and the next
step, "Application Questions 1 of 2", recorded exactly one decision: a
"Resume/CV" upload (`file-upload-input-ref`) that paused after "Workday
did not finish uploading ... within 60 seconds"; none of that step's own
questions was read, although an earlier run on the same job read four.
Cause (inferred; the transition markup was not captured): Save and
Continue returns once the progress bar names the next step, while
Workday can keep My Experience's resume input in the page, hidden, until
the next step is drawn. The readiness wait counted resume inputs without
a visibility check, so it returned on that hidden input, and the step
reader's fallback turned it into a "Resume/CV" field. Fix: a resume
input counts for the readiness wait and the fallback only while it or
its wrapper is shown (`packages/browser/src/ats/workday.ts`).
Regression: the `?gaps=1&linger=2500` "workday lingering step" scenario
in `testing-harness/browser/fixture-run.ts` (`pnpm test:browser:fixture`),
where My Experience lingers hidden for 2.5 s after the progress bar
moves.
