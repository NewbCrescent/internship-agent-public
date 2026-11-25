# A "Sex" question was not read as self-identification

Found in pass 16 (2026-11-25) on Lockheed Martin's Eightfold application (run
<run id>): the "Sex" question paused as a plain question, not a sensitive one,
so it neither took the candidate's saved self-identification answer nor was
kept out of question memory. Cause: the `eeo` role pattern in
`packages/browser/src/ats/field-roles.ts` had no "sex", although
`ats/self-identification.ts` already treats "sex" as the gender category.
Fix: "sex" as a whole word that is not "sex offender" is an `eeo` question, so
it takes the saved answer only on a single matching option of a list that lets
the candidate decline, and otherwise pauses as sensitive with nothing stored.
Regressions: the Track 35 cases in `pnpm test:browser-worker:fast`, `pnpm
test:browser:unrecognized-forms`, and the unrecognized site run in `pnpm
test:browser-worker:local`.
