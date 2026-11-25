# Browser verification rewrites the tracked `next-env.d.ts`

`testing-harness/browser/run.mjs` sets `NEXT_DIST_DIR=.next-verify`, and Next.js
rewrites `apps/dashboard/next-env.d.ts` to import route types from that directory.
The tracked file is left modified after every `pnpm test:browser` run and has to be
restored by hand before a commit.

Reproduce: `git diff --quiet -- apps/dashboard/next-env.d.ts && pnpm test:browser && git diff -- apps/dashboard/next-env.d.ts`

Confirmed 2026-09-22. Not a product defect; it makes verification leave churn in the
working tree, so a real change can be missed in a diff review. A fix likely means
restoring the file inside the runner's existing cleanup block, next to where it
removes the temporary data directory.

`next build` rewrites it too (to `./.next/types/routes.d.ts`), so
`pnpm agent:finish` left the same churn through its build step.

Fixed: `testing-harness/support/next-env.mjs` snapshots the file; the browser
runner restores it in its cleanup block (`BROWSER_RUN_REPORT` includes
`nextEnvRestored`) and `agent:finish` restores it after every step. Verified:
the file is unchanged after `pnpm test:browser` and after
`pnpm agent:finish profile`.
