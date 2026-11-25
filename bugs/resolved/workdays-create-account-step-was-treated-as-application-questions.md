# Workday's create-account step was treated as application questions

Runs <run id> (employer-a.wd115) and <run id> (employer-b.wd3) paused on "Email
Address", "Password", and "Verify New Password", so the account flow never
ran. Real Workday sites draw the apply flow, with its "Create Account/Sign
In" step, before the account form: entering saw the flow, the sign-in check
ran before the password field existed, and the walk read the account step's
`formField-*` containers as questions. The account screen also always wraps
the create button in `noCaptchaWrapper` with no challenge inside, which the
account reader took for a CAPTCHA. Now entering reads the active step, a walk
that meets the account step or a password field signs in (or creates the
account) once and walks again, and only a frame inside `noCaptchaWrapper`
counts as a CAPTCHA. Regressions: the real-markup scenario in
`testing-harness/browser/workday-account-run.ts`
(`pnpm test:browser:workday-account`, fixture `?markup=real`) and the
account-step scenarios in `run-lifecycle.integration.test.ts`.
