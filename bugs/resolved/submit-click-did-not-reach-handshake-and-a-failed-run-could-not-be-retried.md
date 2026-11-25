# Submit click did not reach Handshake, and a failed run could not be retried

The Example Co submit step on 2026-09-22 clicked "Submit Application" by
dispatching `element.click()` from a page script, read the page once, found
no confirmation, and closed the browser. Handshake recorded no application.
A script-dispatched click is untrusted and may be ignored, and closing
immediately would cut off a submission still in flight. The run was marked
failed with the job left in APPLYING, where `startBrowserRun` refused to
start a new run. Reproduced with the Handshake-style fixture: a submit
handler that ignores untrusted clicks and confirms after 1.5 seconds failed
with the same message.

Fixed: the adapter picks the submit control in the page and clicks it with a
real Playwright mouse click, and `submitAndConfirm` keeps the page open for up
to 30 seconds watching for a new confirmation (reporting separately when the
dialog closed without recognizable text). A new run may start when the
latest run failed or was cancelled and no run was ever submitted. Regressions:
the fixture's trusted-only, delayed submit; `submission confirmation` in
`testing-harness/browser-worker/recognition-planner.test.ts`; and `retrying a
browser run` in `testing-harness/browser-worker/run-lifecycle.integration.test.ts`.
