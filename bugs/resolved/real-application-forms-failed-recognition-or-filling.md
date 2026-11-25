# Real application forms failed recognition or filling

The 2026-09-24 fill pass exposed three defects, reproduced read-only against
the live pages. Ashby forms render client-side: the Example AI form had 0
controls at load and 45 six seconds later, so every Ashby run stopped with
"No application form was found". An Example Aerospace Greenhouse question label ran
past the 300-character field limit, and recognition rejected the whole form
with a validation error. Greenhouse education "Start date year" boxes are
`type=number`, and the question mapper's `start date` rule mapped them to
the internship availability date, so the planner tried to type a full date
into a year box (on a text box it would have filled the wrong fact).

Fixed: the Playwright adapter waits for a form's controls to appear and
settle before reading; recognition trims labels, ids, and option lists to
their limits (options raised to 500); `type=number` is its own field kind,
filled only with numeric values; and year/month/day components are
excluded from the availability-date rule. Regressions: the fixture run's
delayed-form step (0 fields without the wait, 3 with it),
`real-form robustness` in `recognition-planner.test.ts`, and the mapper's
date-component test. `pnpm pipeline:run --retry-stopped` retries the
affected applications.
