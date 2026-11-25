# Dover application forms were not read or recognized

On 2026-11-20 Mindsmith, Headstarter, Deccan AI, and Revealed (all
app.dover.io application pages) paused with labels that were a zero-width
space (U+200B) and one UUID. Read-only captures of two Dover pages
(2026-11-20) showed the causes. Each input sits in an MUI outlined box whose
notched-outline legend holds only U+200B, and that legend won the label
search because whitespace collapsing does not remove zero-width characters.
The visible question ("First Name *", "Resume *", "What is your Visa Status?
*") is a sibling `div` with class `styles__FormLabel-…` (capital L), which
the in-page collector's `[class*="label"]` did not match, so fields read as
their names ("firstName") or as UUIDs. The relocation radio took its first
option's own label ("Yes"), and both uploads read "Yes" because the upload
label walk in `fileLabel` climbed past other questions to a radio option.
An "Autofill from resume" drop zone before the form read as a question. And
app.dover.io redirects to `jobs.dover.com/job/<id>`, which nothing classified,
so the kind was unknown.

Now every label source in `collectControlsIn`
(`packages/browser/src/handshake-executor.ts`) and `recognizeFields`
(`packages/browser/src/form-recognition.ts`) drops invisible characters
(`INVISIBLE_CHARACTERS`), a bare UUID counts as empty, a name holding a UUID
never labels a control, and an option made only of invisible characters is
dropped. The question text near a control also matches a case-sensitive
`[class*="FormLabel"]`. An option's own label (a label holding exactly one
radio or checkbox) and aria-hidden text are never a question's label. An
upload's label walk stops at an ancestor holding another question's control.
A `role="button"` drop zone that says "autofill" is skipped like Ashby's
parser box. The `dover` kind matches `app.dover.io` and `jobs.dover.com` URLs
(and the footer's "By applying you agree to Dover's terms").

Dover proceeds automatically: it is one page with one Apply submit, and its
"Thanks for applying!" is recognized by the existing confirmation pattern.
Its hidden Turnstile token is page machinery; a visible Turnstile widget
still holds the run. A real Dover submit has not been run. Regressions: the
Dover block of `testing-harness/browser/greenhouse-fixture-run.ts` (`pnpm
test:browser:greenhouse`, fixture `dover-application.html`), the Dover cases
in `testing-harness/browser-worker/ats-classification.test.ts` and the
invisible-character case in
`testing-harness/browser-worker/recognition-planner.test.ts` (`pnpm
test:browser-worker:fast`).
