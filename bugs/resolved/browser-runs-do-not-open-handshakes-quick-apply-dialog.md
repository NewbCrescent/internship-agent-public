# Browser runs do not open Handshake's Quick apply dialog

The Handshake worker recognizes whatever form is on the loaded page and, at
submission, clicks the first button whose text matches `submit|apply`
(`clickSubmitInPage` in `packages/browser/src/handshake-executor.ts`). On a
real Handshake job page (`/jobs/<id>`, read on 2026-09-22) the page's own
controls include two "Quick apply" buttons and no application form until
Quick apply is opened. A run would plan against the page's search controls,
and the approved submit step would click "Quick apply" instead of the
dialog's final submit. The worker was only ever exercised against the local
fixture form.

Fixed: Handshake-internal runs click "Quick apply" and scope recognition,
filling, and submission to the "Apply to …" dialog (structure read live
2026-09-22); a matching pre-attached resume is kept, any other attachment
stops the run, and the submit click never counts "Quick apply" or cancel
controls. Confirmations must newly appear after the click. Regressions: the
Quick apply dialog tests in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts` and the
Handshake-style dialog in `testing-harness/browser/fixture-run.ts`. Verified
live: the Example Co application was submitted through this path on
2026-09-22; afterwards the job page shows "Applied on <date>" and "Withdraw
application".
