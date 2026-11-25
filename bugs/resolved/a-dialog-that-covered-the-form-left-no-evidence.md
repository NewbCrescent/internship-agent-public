# A dialog that covered the form left no evidence

On Lockheed Martin run <run id> (pass 19, 2026-11-25) the work authorization, sponsorship, previously-worked, pronoun, how-heard, and two self-identification lists paused with "a dialog covers the form" after the agent signed the typed-name attestation and uploaded the resume.
The run saved no screenshot or text of that dialog (the job's folder held only uploads), so nobody could tell whether it was a session-expiry notice, a resume-parse confirmation, or something else.
The pause also said only "Answer it here, or fill it in the browser.", without saying that the agent leaves such a dialog open or where to see it.
Fix: the first field in a run that a modal dialog leaves unfilled saves one `covering-dialog` capture while the dialog is up (the screenshot, the redacted visible text, and each dialog's redacted text, role, aria attributes, and button labels), read without clicking anything, and viewable with `pnpm run:evidence --run <ref>` (`captureCoveringDialogEvidence` and `readCoveringDialogsIn` in `packages/browser/src`, `saveCoveringDialogEvidenceQuietly` in `packages/agent/src/submit-evidence.ts`).
The pause now says the agent does not click through or close such a dialog, and asks the candidate to look at it in the browser, naming the `pnpm run:evidence` command for the run.
Regressions: scenario (e) of `pnpm test:browser:unrecognized-forms`, the covering-dialog cases in `pnpm test:browser-worker:local`, and the Track 39 block in `pnpm test:agent:evidence`.
What the dialog on run <run id> was is still open until the next real Eightfold run saves its capture.
