# Workday's "How Did You Hear About Us?" list was read before it loaded

Found 2026-11-25 on the real workspace. In the pass from about 04:05 to
04:22Z, runs <run id> and <run id> (rockwellautomation.wd1) and <run id>
(highmarkhealth.wd1, an enGen posting) paused on My Information's
`formField-source` with no options, although the candidate has a saved
`how_heard` answer and the how-heard rule; micron.wd1 and littelfuse.wd1
chose it in the same pass. Cause: `openPromptOptions` waited for the first
visible `promptOption`, which the Country Phone Code field's picked chip
satisfied at once, then gave the list 300 ms and read only options that
were not on screen before the click; a category's sub-list was given a
fixed 700 ms. A list that took longer was read as empty. The adapter now
closes any open list first, waits up to 5 s for prompt options outside
picked items that were not on screen before the click, reads them once two
reads 150 ms apart agree, and polls a category's sub-list the same way
(`packages/browser/src/ats/workday-lists.ts`). Regression: the
`?widgets=real` scenario of `testing-harness/browser/fixture-run.ts`
(`xvfb-run -a pnpm test:browser:fixture`), whose prompt list shows 600 ms
after the click and whose sub-list 900 ms after the category; the old code
paused on the field with no options. Not verified live: whether those
tenants' lists only load slowly, as the fixture models, or need another
gesture to open; the live proof is the next pass on those hosts.
