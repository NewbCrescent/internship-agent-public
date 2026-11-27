# An Ashby control drawn again after an upload lost its tag and timed out

Blocker board 2026-11-27: b998c1c1117 ("saved answer not used: \"location\"") and b5933eef4cf ("question: \"where are you located\"").
Held Ashby runs: Apex <run id> Q1 "Location", Apex Technology, Inc. <run id> Q1 "Location", Reliable Robotics <run id> Q8 "Location", Base Power Company <run id> Q6 "Current Location", Strava <run id> Q14 and <run id> Q12 "Where are you located?", and TELUS Digital <run id> Q10 "Where are you located?" (with "Where did you hear about us?", "When is your anticipated graduation date?", and "School").
Each pause reads "The agent could not fill …: the field did not respond in time", a planned fill the executor could not apply: the planner had matched the label and planned the profile's "City, Region".
In run traces <run id>, <run id>, <run id>, and <run id> the location box was tagged `data-ia-control="ia-control-2"` at recognition, an upload made Ashby redraw the form ("Autofill completed!"), and at fill time the tag counted 0, so `locateField` fell back to `getByLabel`, which matches no element because Ashby's `label for="_systemfield_location"` names none, and timed out after 10 s.
Track 67 stops the trigger it found (the resume going into Ashby's autofill box on survey forms); this fix covers any redraw of a tagged control.
Fix (Track 71, `locateField` and `redrawnTagged` in `packages/browser/src/handshake-executor.ts`): a tagged control that is gone is found again by collecting the controls once more and taking the one field with the same label, when it is a tagged control; two fields with that label find none.
Regression: `pnpm test:browser:greenhouse` (`fixtures/ashby-application.html?rerender=1`): after the Resume upload redraws the location box, the profile's "City, Region" picks the one matching suggestion, and "Berkeley", which two suggestions match, is left unfilled with no suggestion matched; both fail on the old code with "the field did not respond in time".
These pauses are not re-checked by `questions:recheck` (it skips "The agent could not fill" pauses); they move when the held runs are retried.

fixture: modelled (the redraw after the Resume upload is modelled from run traces <run id>, <run id>, <run id>, and <run id> of 2026-11-27; the location box markup is from the 2026-11-20 capture and Apex's stop capture of 2026-11-27)

Resolved once a live Ashby run fills a type-ahead after a redraw.

## Refuted causes
- No current-location answer was saved. Evidence: read-only check of the real database (2026-11-27): the profile's city and state are present, and a current question-memory answer for "Location" exists.
- The question mapper or planner did not recognize the question. Evidence: the pauses' text comes from `unfilledPause` in handshake-executor.ts, which replaces a planned decision; `CONTACT_LABELS` currentLocation matches "Location", "Current Location", and "Where are you located?".
- Ashby's suggestions did not match the typed "City, ST". Evidence: trace <run id> shows nothing was typed; the first call on the box, `fill internal:label="Location"i`, timed out after `[data-ia-control="ia-control-2"]` counted 0.
- The box was only slow and needed a longer timeout. Evidence: the same trace; the label locator matches no element, since the label's `for` names no element.
- The page was reloaded. Evidence: trace <run id> shows one navigation (one goto) before the fills.
