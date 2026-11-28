# Ashby's education history dates were read unlabeled and Still Student? waited

Held Ashby runs paused on 16 "Unlabeled select control N" questions and a "Still Student?" box: Amplify <run id>, ibotta <run id> and <run id>, and Allen Control Systems <run id> and <run id> (board blockers bcf6aedd853 and b483783e625).
Cause: Ashby's Education History entry draws its Start Date and End Date as pairs of month and year lists ("Month..." plus twelve months, "Year..." plus years) with no id, name, or label; the label walk stopped at the ancestor holding the partner list, so each list read unlabeled and paused.
The End Date year list stops at 2027, before the candidate's graduation year, and nothing ticked "Still Student?" (`_systemfield_education_history-isCurrent`) for a current student.
Fix (Track 83): a month or year list with no label takes its date's label plus the part, prefixed "Education " inside the education history entry ("Education Start Date month") (`datePartLabel` in `packages/browser/src/handshake-executor.ts`); the planner answers those lists like Greenhouse's education dates, ticks "Still Student?" while the graduation date is ahead, and leaves the End Date month and year empty when that box is on the form and the year list lacks the graduation year (`educationDecision` and `withEducationFormFlags` in `packages/browser/src/autofill-planner.ts`).
Regression: `pnpm test:browser:greenhouse` (fixture `testing-harness/browser/fixtures/ashby-education-history.html`) and `pnpm test:agent` (`testing-harness/agent/held-question-corpus-track83.test.ts`).
fixture: modelled (from the body text order of a real Ashby run's trace and the stored ids; the structure around the lists is not captured).
If Ashby still requires the End Date after "Still Student?" is ticked, the submit returns field errors and the run pauses; no wrong value is chosen.
Stays open until a live Ashby run fills the dates and the box.
