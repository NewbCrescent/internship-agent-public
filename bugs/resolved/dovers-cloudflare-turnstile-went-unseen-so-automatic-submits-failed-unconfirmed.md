# Dover's Cloudflare Turnstile went unseen, so automatic submits failed unconfirmed

On 2026-11-24 five automatic Dover submissions (jobs.dover.com, where
app.dover.io links redirect) failed with "The submit button was clicked but
no new confirmation appeared". Each post-submit screenshot shows the filled
form, the Apply button, and an unchecked Cloudflare "Verify you are human"
Turnstile widget above it (one with the widget's area still blank), and no
thank-you, toast, or field error. Cause: Turnstile draws its frame inside a
closed shadow root, so `findVisibleChallengeIn`'s iframe scan never saw it and
its text is inside the frame, not the page body; `submitBrowserRun` also
checked for a challenge only on opening, before the widget rendered. Fix: the
Playwright page's `visibleChallenge` also reads the browser's frame tree and
counts a shown `challenges.cloudflare.com` frame (visible, at least 20×20 px;
never evaluated in, clicked, or typed into) as a Turnstile challenge, and
`submitBrowserRun` reads the page again after filling, right before the click:
a widget found there withdraws the approval and pauses the run as a safeguard
with nothing clicked; one drawn by the click holds the run as challenged with
evidence. The five runs stay failed with their possible-submission holds.
Regressions: the Dover `?turnstile=` scenarios in
`testing-harness/browser/greenhouse-fixture-run.ts`
(`pnpm test:browser:greenhouse`), "holds a run whose CAPTCHA appears while the
form fills" in `testing-harness/browser-worker/run-lifecycle.integration.test.ts`
(`pnpm test:browser-worker:local`), and `isTurnstileFrameSource` in
`testing-harness/browser-worker/recognition-planner.test.ts`
(`pnpm test:browser-worker:fast`).
