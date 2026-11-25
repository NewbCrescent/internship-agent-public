# Workday ignored an account submit made within 500 ms of the form appearing

From 2026-11-20 to 2026-11-24 the account submit got no answer at employer-f.wd1,
employer-h.wd501, tmobile.wd1, saabusa.wd1, neogen.wd5 and littelfuse.wd1;
where the diagnostics were recorded they read "no same-host request
observed; no page transition observed". A cookie banner was on some of these
sites and not on others. Cause: Workday's sign-in widget
(candidate-experience-apply-flow 2026.47.19, read 2026-11-24) installs three
"NoCaptcha" tests when an account submit button mounts: a 500 ms timer, the
empty `beecatcher` honeypot, and a click on the click filter over that
button. Its form `onSubmit` calls `preventDefault()` with no message while
one of them has not passed. Against the synthetic fixture, `signInToWorkday`
clicked the sign-in filter 62–82 ms after the sign-in submit button appeared
(after the Sign In link or the email chooser), and `createWorkdayAccount`
116–598 ms after the create button, so the timer test fails silently.
On 2026-11-24 the candidate chose ("yes a second") to let Workday account
submits wait about one second after the form appears, so this minimum-time
check passes; AGENTS.md's site-safeguard invariant records it as the only
such allowance. `signInToWorkday` and `createWorkdayAccount` now note when
they first see the form (its submit button, or the click filter over it,
visible) and click no sooner than 1,000 ms after that moment, so typing time
counts and a slow page does not wait twice. It is still one plain click, the
honeypot is never typed in, and a visible challenge still holds the host.
Regression: the dwell scenario in
`testing-harness/browser/workday-account-run.ts` (`pnpm
test:browser:workday-account`), against the fixture's `?dwell=1` mode, which
drops without a message a submit clicked under 500 ms after its button
mounted; there the old code dropped both the create submit and the sign-in
submit after it. The live proof is still a real sign-in.
