# Ashby's autofill box on survey forms took the resume and redrew the form

TELUS Digital (<run id>, <run id>, <run id>), Apex Technology (<run id>,
<run id>), and Reliable Robotics (<run id>) on Ashby planned
`ia-control-1 = upload`: a file input with neither id nor name, Ashby's
"Autofill from resume" box.
Trace <run id> shows `setInputFiles` into `[data-ia-control="ia-control-1"]`,
the stop capture shows "Autofill completed! Please review the information we
filled in for you below.", and every later `[data-ia-control="ia-control-N"]`
lookup counted 0, so the executor fell through to a label locator (Ashby's
`label for=` names no element) that timed out after 10 s: "Where did you
hear about us?", "Where are you located?", "When is your anticipated
graduation date?", and "School" ("the field did not respond in time"), and
Apex's and Reliable Robotics' "Location".

Cause: `collectControlsIn` (`packages/browser/src/handshake-executor.ts`)
excluded only a file input inside `.ashby-application-form-autofill-pane`.
Ashby's public bundle (index-DYKNvNNQ.js, read 2026-11-27, no submission
made) draws that box as `ashby-application-form-autofill-pane` for a single
form but as `ashby-application-form-autofill-uploader` for a form with
surveys (TELUS has a "Voluntary Demographic Question" survey), and the box
itself always as `ashby-application-form-autofill-input-root`.
An upload there makes Ashby parse the resume and redraw the form, which
drops the `data-ia-control` tags that locate fields with neither id nor name.

Fix (Track 67): a file input inside any of the three is not a question.

Regression: `pnpm test:browser:greenhouse` (fixtures/ashby-survey-autofill.html,
a fictional survey form whose autofill box redraws the form when a file is
chosen): the uploader's input is not recognized, the resume goes only into
Resume, the form is never redrawn, and the Location type-ahead is picked.
It fails on the old code with the same "the field did not respond in time".

fixture: modelled (class names from Ashby's public bundle index-DYKNvNNQ.js read 2026-11-27; inner markup from the 2026-11-19 Ashby capture; the redraw modelled from run trace <run id>)

Resolved once a live Ashby run on a form with surveys fills its type-aheads.

## Refuted causes

- The fields were too slow and needed a longer timeout. Evidence: trace <run id>, where each [data-ia-control="ia-control-N"] count was 0 after the autofill upload, so the executor fell through to a label locator that matches no element.
- The page was reloaded and lost its tags. Evidence: trace <run id> shows one navigation (one goto) before the fills.
