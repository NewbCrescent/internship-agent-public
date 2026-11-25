# A type-ahead field's timeout stopped the whole run

Solvik and Fernwave Sciences (Ashby) stopped with `locator.fill: Timeout 30000ms
exceeded. waiting for getByLabel('Start typing...')`: the location box had no
label but its placeholder, so the filler looked for a label that did not
exist, and any page error ended the run with a raw Playwright message. Now
type-ahead fields are typed into and the matching suggestion picked (exact or
the only one, never a guess), the question text near an unlabeled control is
its label, and a field the page will not take becomes a pause with a plain
reason; before a submit click it holds the run with the approval withdrawn.
Regressions: `run-lifecycle.integration.test.ts` (timeouts at start, submit,
on the pipeline, and on a Workday step), `recognition-planner.test.ts`
(`matchSuggestion`), and the Ashby, Lever, and Greenhouse "Location (City)"
scenarios of `pnpm test:browser:greenhouse`.
