# Workable application sites were not recognized and their Yes/No questions were not read

Found 2026-11-27 in Track 77's triage of the "The application site type was not recognized automatically" blocker (b096af2a79d).
Digital Control's run <run id> (`apply.workable.com/digital-control/j/AB9A181560/apply/`) was awaiting approval as an unknown site (confidence 0): the agent had no Workable kind.
It filled nine fields but never read the two required Yes/No questions (work authorization and sponsorship; Workable's public form API for the job lists them as required booleans).
Cause: Workable draws each option as `div[role=radio][aria-checked]` > `label` > a native radio with `aria-hidden="true"` and `tabindex="-1"` and a "YES" or "NO" span, inside a `fieldset role="radiogroup"` labelled by its question, and `collectControlsIn` dropped every aria-hidden, tabindex -1 input as a react-select shadow input.
Fix: Workable is the `workable` kind (`packages/domain/src/ats.ts`, `packages/browser/src/ats/classifier.ts`, `ats/adapters.ts`), confirmed automatically only on its own hosts; a radio inside a `role="radio"` element is read as its option, chosen by clicking the option, and read back from `aria-checked`; `applicationUrlFor` opens a posting's `/apply/` page (`079-workable-applications.md`).
Workable is not in `ATS_KINDS_NEEDING_APPROVAL`: like Dover it is one page with one "Submit application" control, and its "Your application has been submitted successfully." is read by the confirmation pattern; widening the auto-submit policy this way was approved under the candidate's full authority of 2026-11-27, relayed by the manager, on the same basis as Dover.
Regression: the Workable scenario in `testing-harness/browser/greenhouse-fixture-run.ts` (`xvfb-run -a pnpm test:browser:greenhouse`, fixture `workable-application.html`) and the Workable cases in `testing-harness/browser-worker/ats-classification.test.ts` (`pnpm test:browser-worker:fast`).
Not verified: Workable's radio CSS and success container (assumed in the fixture) and a live Workable submit.
fixture: captured 2026-11-27 (read-only headful capture of the application page; texts from Workable's public bundle)

## Refuted causes

- Workable's form cannot be read by the generic filler. Evidence: run <run id> filled nine of its fields; only the two aria-hidden radio groups were dropped.
