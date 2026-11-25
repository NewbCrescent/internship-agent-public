# Greenhouse applications embedded in company careers pages were not followed

Found 2026-11-25 on the real workspace. Oscar's posting
(oscarhealth.com/careers/jobs?gh_jid=…, <run id>) stopped with "No
application form was found … It may sit behind an Apply button". The page
draws Greenhouse's application in a cross-origin iframe
(`job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>`); its two
Apply buttons read "Apply\nApply", and the agent's Apply entry read only
same-host frames, so nothing was followed. Greenhouse's own job page for
the board redirects back to the careers page. Fix: the Apply entry and the
site walker now open the embed's own address (`greenhouseEmbedTarget` in
`packages/browser/src/apply-entry.ts`): an embed iframe or frame whose job
equals the page's `gh_jid`, or, with a `gh_jid` and exactly one Greenhouse
embed script on the page, the address that script builds; the board is
read only from the page, never guessed. Regressions: the embed cases in
`testing-harness/browser-worker/ats-classification.test.ts`
(`pnpm test:browser-worker:fast`) and the embed scenarios in
`testing-harness/browser/site-navigation-run.ts`
(`xvfb-run -a pnpm test:browser:site-navigation`). Not changed: Nintendo's
posting (<run id>) carries a `gh_jid` but its page has no Greenhouse
embed, so it stays stopped; whether Greenhouse's embed confirms a
submission like the job board does was not verifiable without a real
submission (an unrecognized confirmation holds the run).
