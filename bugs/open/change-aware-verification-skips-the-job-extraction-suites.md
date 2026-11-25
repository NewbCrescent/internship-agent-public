# Change-aware verification skips the job extraction suites

`testing-harness/support/agent-workflow.mjs` maps `packages/jobs/` only to the
`foundation` feature, so `pnpm agent:verify` after an extractor change does not
select `job-normalization-contracts` or `discovery-contracts` (both `jobs`).
On 2026-10-13 a change to `packages/jobs` passed `agent:verify` while
`pnpm agent:finish jobs` failed on an outdated `parseJobListOptions`
expectation. Fix direction: map `packages/jobs/` to `jobs` and `ingestion`.
