# Rippling application pages were not recognized

On 2026-11-20 Bound (ats.rippling.com) was held with "The application site
type was not recognized automatically" although every field was filled.
Rippling is now kind `rippling` (`ats.rippling.com` URLs), recognized for
display and in `ATS_KINDS_NEEDING_APPROVAL`, so the candidate approves each
run: a read-only capture (2026-11-20) shows its form at `<posting>/apply`
behind an "Apply now" button, a progress bar on that page, and no success
text in the page's own bundles (only a translation key, `successfullyApplied`),
so a submitted run could not be told from a stalled one and no confirmation
phrase was added. No Rippling fixture was built (the capture allowance for
Rippling pages is used up). Bound's run now shows "Rippling application sites
are recognized, but the agent has no adapter that walks their application, so
you approve each one." instead of "not recognized". Still open: on the static
capture Rippling's uploads, inside `label[aria-labelledby]`, read as
unlabeled (Bound's live run filled every field). Regressions: the Rippling cases in
`testing-harness/browser-worker/ats-classification.test.ts` (`pnpm
test:browser-worker:fast`).
