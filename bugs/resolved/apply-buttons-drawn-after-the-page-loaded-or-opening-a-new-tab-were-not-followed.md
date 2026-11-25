# Apply buttons drawn after the page loaded, or opening a new tab, were not followed

Found 2026-11-25 on the real workspace. Carnival's Oracle Candidate
Experience posting (<run id>) draws its Apply Now button 1.5–2.5 s after the
load event, after the controls wait had already returned, so neither the
Apply entry nor the walker saw it ("No application form was found").
NVIDIA's Eightfold posting (<run id>) has an "Apply Now" button that opens
the employer's Workday posting in a new tab; the agent clicked it, read the
unchanged address, left the tab open, and stopped with "no entry". Fix:
`followApplyEntry` looks again every 500 ms for up to 8 s; a clicked button
waits up to 5 s for the address to change or a new tab (`clickApplyEntry`),
and a new tab is read, closed, and followed only to the same site, the
company domain, or a known ATS host (`adoptablePopup`). An entry that
reaches a Workday posting ends the walk as `adapter`, and `startBrowserRun`
hands the run to the Workday run after closing the posting page, behind the
pipeline's Workday gates on automatic runs (a connected sign-in, else the
account opt-in with the host not held). Regressions: the `adoptablePopup`
cases in `testing-harness/browser-worker/ats-classification.test.ts`
(`pnpm test:browser-worker:fast`), the late Oracle and Eightfold scenarios
in `testing-harness/browser/site-navigation-run.ts`
(`xvfb-run -a pnpm test:browser:site-navigation`), and the Workday handoff
cases in `testing-harness/browser-worker/run-lifecycle.integration.test.ts`
(`pnpm test:browser-worker:local`). Not changed: Corvane's Oracle posting
(2026-11-21) showed the same symptom and was not probed again; the handoff
does not look for another job record of the same Workday requisition (none
exists for NVIDIA's); Microsoft's apply pages (<run id>, <run id>,
<run id>) need a Microsoft sign-in and stay stopped.
