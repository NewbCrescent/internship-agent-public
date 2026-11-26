# Workday's sign-in click filter labelled "Submit" was not clicked

On 2026-11-24 Rockwell Automation (rockwellautomation.wd1) held the host
with "the account step failed in the browser (the Sign In button could not
be clicked)"; KLA (employer-i.wd1) logged the same on 2026-11-20 (not re-checked
live). A read-only live capture of Rockwell's sign-in step (2026-11-24,
disposable profile, nothing typed or submitted) showed the click filter over
`signInSubmitButton` labelled "Submit", not "Sign In"; Workday labels the
filter by its internal auth view, and the create filter there reads "Create
Account". `press` in `packages/browser/src/ats/workday-account.ts` took only a
filter carrying the button's label, so it fell back to the hidden button
under the filter, and the click timed out after 10 seconds. The cookie banner
was not the cause: it sits in normal page flow at the top (position static,
no full-viewport backdrop), and `elementFromPoint` at the button's centre
returned the "Submit" filter. The click now goes first to the one visible
click filter inside the `noCaptchaWrapper` holding the form's own submit
button, whatever its label; the label rules remain as fallbacks. Rockwell's
sign-in then meets the 500 ms gate above. Regression: the submit-label
scenario in `testing-harness/browser/workday-account-run.ts` (`pnpm
test:browser:workday-account`).

## Refuted causes

- The cookie banner covering the Sign In button. Evidence: the read-only live capture of Rockwell's sign-in step (2026-11-24) showed the banner in normal page flow at the top (position static, no full-viewport backdrop), and `elementFromPoint` at the button's centre returned the "Submit" click filter.
