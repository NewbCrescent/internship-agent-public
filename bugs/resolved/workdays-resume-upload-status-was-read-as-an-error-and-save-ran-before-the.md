# Workday's resume upload status was read as an error, and Save ran before the upload finished

Found 2026-11-25 on the real workspace, in manual pass 8. My Experience
on itw.wd5 (<run id>, <run id>), littelfuse.wd1 (<run id>), neogen.wd5
(<run id>) and Activision (<run id>) paused on "Resume/CV: <file>
loading", and on zoll.wd5 (<run id>) on "Resume/CV: <file> successfully
uploaded"; the evidence showed the file tile still loading and Save and
Continue greyed, and Activision also had Workday's "Upload a file (5MB
max) is required" error. Cause: the adapter returned right after
choosing the file and the walk clicked Save and Continue at once, while
Workday was still reading it; and the upload widget's status line, which
sits in the upload's `formField-` container as an alert, was read as a
field error, so the step counted as not saved (on ZOLL the upload had
finished, so this alone stopped it). The adapter now waits up to 60 s
for Workday's own upload widget (`file-upload-input-ref`) until the file
is listed and no longer loading ("<file> successfully uploaded", or the
file listed with no status on two reads 500 ms apart); a failure Workday
reports, or no finish in time, pauses the upload with Workday's words;
and the status line ("<file> loading", "<file> successfully uploaded")
is never read as an error (`isWorkdayUploadStatus`, `workdayUploadState`
in `packages/browser/src/ats/workday.ts`). Regression: the
`?upload=slow` and `?upload=fail` scenarios of
`testing-harness/browser/fixture-run.ts` (`xvfb-run -a pnpm
test:browser:fixture`) and the upload-status cases in
`testing-harness/browser-worker/workday.test.ts` (`pnpm
test:browser-worker:fast`). Not verified live: Workday's upload markup
beyond the recorded text.
