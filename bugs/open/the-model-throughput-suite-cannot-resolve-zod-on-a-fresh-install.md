# The model-throughput suite cannot resolve zod on a fresh install

`testing-harness/jobs/model-throughput.test.ts` imports `zod` directly, but
neither the root `package.json` nor `packages/jobs` declares it, so after a
fresh `pnpm install --frozen-lockfile` (PC, 2026-11-17) the file fails to load
and takes `test:jobs:fast` (job-normalization-contracts and
discovery-contracts) down with it; the other four files in that script pass.
Fix direction: declare `zod` where the test resolves it, or import the schema
helpers through a workspace package.
