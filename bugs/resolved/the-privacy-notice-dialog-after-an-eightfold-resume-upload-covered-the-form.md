# The privacy notice dialog after an Eightfold resume upload covered the form

On Lockheed Martin run <run id> (Eightfold, 2026-11-25) seven lists paused with "a dialog covers the form".
Track 39's capture showed the dialog: a modal "Privacy Notice and Security Agreement" with a system-use acknowledgment, a privacy-notice acknowledgment, and consent to processing personal information, answered with "I Agree", "Cancel", or Close.
Cause: the resume upload opens it, and the agent never clicks inside a covering dialog, so every later list click was covered, although the candidate's standing settings accept privacy-policy and data-processing consent and privacy-notice acknowledgments that are a condition of applying.
Fix: `applyDecisions` reads a covering dialog's full text (`readStandingDialogsIn`, closed sections included) after an upload and on a covered field, decides it with the standing-consent classifier (`standingDialogDecision`, `packages/browser/src/standing-dialog.ts`), clicks only its one agree button when every operative statement is accepted under the settings, logs the click with the exact text on the timeline, and tries the field once more.
A dialog with marketing, fact, text-message, cookie, sign-in, or session wording, clipped or hidden text, a form field, or any other button is left to the candidate, still pauses with "a dialog covers the form", keeps Track 39's capture, and is logged with the reason it was left.
Regressions: scenario (j) of `pnpm test:browser:unrecognized-forms`, the Track 40 block in `pnpm test:browser-worker:fast`, and the Track 40 cases in `pnpm test:browser-worker:local`.
Boundary: what the live dialog's closed sections say, and whether agreeing keeps the uploaded file, are confirmed only by the next real Eightfold run.
