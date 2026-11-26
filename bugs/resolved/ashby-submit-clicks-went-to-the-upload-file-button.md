# Ashby submit clicks went to the "Upload file" button

Every real Ashby submit ended unconfirmed: Lumora (<run id>), Brightlane (<run id>), First Resonance (<run id>, <run id>, <run id>,
<run id>, <run id>, and the <run id>/<run id> runs) and Contoro (<run id>,
<run id>, <run id>). The First Resonance <run id> and Contoro <run id>
records of 2026-11-25 08:4xZ show no reCAPTCHA token request and no submit
after the click; the only Ashby call is an answer save made before it.
Cause: the agent's submit choice (`findSubmitIndex`) read each button's
`type` property as part of its text, and a `<button>` with no type
attribute reports "submit". Ashby's public bundle (index-DYvFpVME.js, read
2026-11-25) draws every button through one Button component with no type
attribute, and the "Autofill from resume" pane's "Upload file" button comes
before the form, so it read as "Upload file submit" and every click went
to it; it sends nothing. The fixture gave its buttons `type="button"`,
which hid this. This corrects earlier explanations: Track 16's busy notice
never appeared in those captures (their detail is empty), Track 22's H6
(the click never reached Ashby's handler) was the right one, and
hypothesis (c), a client-side check, is ruled out by Ashby's handler, which checks only
pending saves before it asks reCAPTCHA Enterprise for a token, reads a
device fingerprint, and sends the submit mutation. Now Ashby's own submit
button (`.ashby-application-form-submit-button`) is always chosen on
Ashby, while visible even when disabled; elsewhere the text (or an input's
value) decides, then "apply", and a submit-typed control is only the last
resort; a button's default type is never read as saying submit. Live
read-only check (2026-11-25, First Resonance's public application page, a
disposable profile, no click or typing): the page showed three buttons,
"Upload file", "Upload File" and "Submit Application", none with a type
attribute; the old choice was "Upload file", the new one Ashby's Submit
Application button, whose hit test at its centre passed; no challenge
was shown. Regressions: the Ashby submitted scenarios of `pnpm
test:browser:greenhouse` with production-typed buttons and the fixture's
autofill-click count. Boundary: whether Ashby accepts a submit from the
agent's browser is unproven until a real attempt; the Lumora SUBMITTED
record from the closed-dialog relabel is not changed here.

## Refuted causes

- Track 16's busy notice (a click refused while an answer save was running). Evidence: it never appeared in the captures (their detail is empty), and the First Resonance <run id> and Contoro <run id> records of 2026-11-25 08:4xZ show no reCAPTCHA token request and no submit after the click, the only Ashby call being an answer save made before it.
- Hypothesis (c), a client-side check. Evidence: Ashby's handler (public bundle index-DYvFpVME.js, read 2026-11-25) checks only pending saves before it asks reCAPTCHA Enterprise for a token, reads a device fingerprint, and sends the submit mutation.
