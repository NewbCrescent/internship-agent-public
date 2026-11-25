# Workday's work-history dates were clicked under their date display

Found on the real workspace: Sierra Space (<run id>), ZOLL (<run id>) and
Neogen (<run id>) on 2026-11-25 and Aerospace (<run id>) on 2026-11-24
stopped on My Experience with "locator.click: Timeout 30000ms exceeded"
on the first Work Experience row's From month spinbutton
(`dateSectionMonth-input`). The section, the row, and the field were all
found, so it was not a missing Add button, a collapsed panel, or an empty
history. Cause: the history filler clicked each date input before typing,
and Workday draws a `dateSection…-display` element over it, so the click
never became actionable. The recorded detail is cut off before
Playwright's reason, so the overlay is inferred from Workday's markup and
public notes. Each date section input is now focused and typed into,
never clicked, and other history inputs fall back to focusing when a click
is not taken within 5 s. Regression: the `?widgets=real` scenario of
`testing-harness/browser/fixture-run.ts` (`xvfb-run -a pnpm
test:browser:fixture`), whose date displays cover their inputs; the old
code's walk threw on the covered month. Not verified live: the history
widgets after the dates (school prompt, degree, field of study) have not
run on a real tenant yet.
