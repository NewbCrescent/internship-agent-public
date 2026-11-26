# Ashby's required single- and multi-choice questions were read as optional

The First Resonance runs (<run id>, <run id> on 2026-11-23; <run id>,
<run id> on 2026-11-25) skipped the required "Visa Support" radio ("Do you
require any visa support to work in the U.S.?") as "Optional field with no
known answer stays empty."; the <run id> evidence screenshot shows its
required star with neither Yes nor No chosen, then Submit Application.
Ashby's public bundle (read 2026-11-24) draws single-choice (ValueSelect)
and multi-choice (MultiValueSelect) questions without the
`.ashby-application-form-field-entry` wrapper: the radio or checkbox group
fieldset holds the `_required` question title inside a bare
`[data-field-entry-id]` div, and its radios carry no `required` attribute.
The agent looked for the title only inside the field-entry wrapper, so these
questions read as optional; the fixture's radio (from the 2026-11-20 Fernwave
capture) had the wrapper, so the fixture passed while production failed. The
title alone ("Visa Support") was also the whole label, which the question
mapper could not read as a sponsorship question. H1 (confirmed defect, the
most likely cause of the First Resonance failures): Ashby's server checks
required fields, so it would not take a submission with Visa Support empty.
Now the required mark is read from the field entry, the `[data-field-entry-id]`
div, or the radio or checkbox group; a short title with no "?" takes Ashby's
question description ("Visa Support: Do you require any visa support to work
in the U.S.?"); and the mapper reads "require/need … visa support" as the
saved, country-scoped sponsorship need (a question naming no country, with no
posting country, still pauses). Track 16's busy-notice explanation did not
apply to these runs: their evidence carries no busy detail. Boundary: whether
the empty answer is why Ashby showed nothing is not proven (no correction
message appeared); the network record (next entry) answers it on the next
real attempt. Regressions: the value-select recognition checks in
`pnpm test:browser:greenhouse` (`fixtures/ashby-value-select.html`) and the
visa-support mapper test in `pnpm test:agent`.

## Refuted causes

- H1, the empty required "Visa Support" answer as the most likely cause of the First Resonance failures. Evidence: Ashby's bundle has no client-side required check, so an empty required answer alone would not stop a submit click from sending (`ashbys-single-choice-answers-were-dropped-when-the-form-was-reloaded-to-submit.md`), and the First Resonance <run id> and Contoro <run id> records of 2026-11-25 08:4xZ show no reCAPTCHA token request and no submit after the click; the clicks went to the autofill pane's "Upload file" button (Track 27, `ashby-submit-clicks-went-to-the-upload-file-button.md`).
