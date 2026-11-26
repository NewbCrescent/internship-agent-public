# The model-throughput suite cannot resolve zod on a fresh install

`testing-harness/jobs/model-throughput.test.ts` imports `zod` directly, but
neither the root `package.json` nor `packages/jobs` declares it, so after a
fresh `pnpm install --frozen-lockfile` (PC, 2026-11-17) the file fails to load
and takes `test:jobs:fast` (job-normalization-contracts and
discovery-contracts) down with it; the other four files in that script pass.
Fix direction: declare `zod` where the test resolves it, or import the schema
helpers through a workspace package.
Fix (Track 58, 2026-11-26): the suite takes its schema from a workspace package (`githubRepositoryRefSchema` from `@internship-agent/domain`) instead of importing `zod` directly, so it loads without a root `zod` dependency and no install was needed.
Regression: `pnpm test:jobs:fast` loads and passes `model-throughput.test.ts` after a fresh `pnpm install --frozen-lockfile` in a worktree.
fixture: not applicable (a test-loading fault, reproduced by a fresh pnpm install --frozen-lockfile in the Track 58 worktree on 2026-11-26)
