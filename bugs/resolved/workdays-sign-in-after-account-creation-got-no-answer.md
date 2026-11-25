# Workday's sign-in after account creation got no answer

On 2026-11-20 (about 20:51Z) Camping World (employer-g.wd5) logged
"account created with your email; the password is saved locally" and then
held the host with "the account step stopped (Workday did not answer the
sign-in submit within 20 seconds)"; Example Brands (examplebrands.wd5) did
the same. The evidence screenshot shows the Sign In form filled, no error.
`press` in `packages/browser/src/ats/workday-account.ts` clicked the first
visible click filter labelled "Sign In" anywhere on the page. The cause is not
confirmed: a read-only capture of employer-g.wd5's public `/login` page
(2026-11-20) shows only the form's own visible "Sign In" filter, beside
`signInSubmitButton` in `noCaptchaWrapper` (the header's "Sign In" there is a
hidden `auth_signin_link`), so the click may have landed correctly and
Workday may ignore sign-ins until the email is verified. Both hypotheses are
now covered. The click goes to the filter beside the form's own submit
button (else a labelled filter inside the sign-in content or a dialog, never
page-wide). A not-verified message ("Your account has not been verified",
"verify your email") is the verification step even when it mentions the
password, and so is such a notice drawn as plain text while the form stays
up. A sign-in that gets no answer right after this run created the account
goes to the Gmail verification flow ("Workday did not answer the sign-in
after the account was created; the agent looks for the verification
email."), which holds as `verify-email` (retried after an hour) when no
email arrives. The live proof is a re-run on those hosts. Regressions: the
decoy (synthetic header filter), notice, and quiet scenarios in
`testing-harness/browser/workday-account-run.ts` (`pnpm
test:browser:workday-account`) and the not-verified cases in
`testing-harness/browser-worker/workday.test.ts` (`pnpm
test:browser-worker:fast`).
