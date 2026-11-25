# Hidden CAPTCHA token fields held runs as CAPTCHAs

In the live pass of 2026-11-20, Greenhouse runs (<run id> on
job-boards.greenhouse.io/orbitline, <run id> on glowpathinc) were flagged
with a CAPTCHA safeguard. Every new Greenhouse board loads the invisible
reCAPTCHA Enterprise badge and its hidden `g-recaptcha-response` textarea; the
generic reader labelled that textarea by its name, and the safeguard pattern
matched "recaptcha" (it also matched any question containing "challenge").
Now the token fields (`g-recaptcha-response`, `h-captcha-response`,
`cf-turnstile-response`) are not controls, only CAPTCHA wording is a
safeguard, and `packages/browser/src/challenge.ts` pauses a run only for a
challenge the candidate would see (a visible reCAPTCHA checkbox or image
challenge, hCaptcha, Turnstile, DataDome, or a human-verification page); a
challenge or a refusal after the submit click holds the run. Detection only
reads the DOM. Regressions: `testing-harness/browser-worker/recognition-planner.test.ts`,
`testing-harness/browser/greenhouse-fixture-run.ts` (`pnpm test:browser:greenhouse`),
and the challenge scenarios in `run-lifecycle.integration.test.ts`.
