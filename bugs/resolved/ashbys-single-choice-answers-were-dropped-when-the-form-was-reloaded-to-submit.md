# Ashby's single-choice answers were dropped when the form was reloaded to submit

Found 2026-11-25 on the real workspace: First Resonance runs <run id>
(job <run id>) and <run id> (job <run id>) had chosen "No" for the
required "Visa Support" radio, yet the post-submit screenshot showed
neither option selected. Cause: Ashby names a single-choice question's
radios after its field entry, `<form render id>_<field path>`, and the
render id is new on every page load (three read-only loads of the public
page gave three ids). The agent used that name as the field's id, so the
run planned on one load named a field the submit-time reload did not
have, `applyDecisions` skipped the choice silently, and the pre-click
check only asked that some approved field was present. The radio was
never clicked. The same ids carried Apex Technology's
self-identification choices (run <run id>). Now these questions are
identified by their field path, Ashby's submit field errors map to it,
the chosen option is read from Ashby's own state (`data-checked`), and
the agent clicks the option's label once and waits for Ashby to show it
chosen. Before every submit click an approved answer missing from the
reloaded form holds the run (`form-changed` safeguard, nothing typed),
and every radio choice is read back: one that did not take pauses its
field ("did not take the choice"), the approval withdrawn, nothing
clicked. Regressions: the per-load and `?stuck=1` scenarios of
`xvfb-run -a pnpm test:browser:greenhouse` (`fixtures/ashby-value-select.html`
draws a fresh render id per load and React-controlled radios derived
from Ashby's public bundle), the read-back and form-changed holds in
`run-lifecycle.integration.test.ts` (`pnpm test:browser-worker:local`),
and the read-back cases in `recognition-planner.test.ts` (`pnpm
test:browser-worker:fast`). Not explained by this fix: Ashby's bundle
has no client-side required check, so an empty required answer alone
would not stop a submit click from sending; why those clicks sent
nothing (no reCAPTCHA token request) stays open until a reopened run's
network record shows it.
