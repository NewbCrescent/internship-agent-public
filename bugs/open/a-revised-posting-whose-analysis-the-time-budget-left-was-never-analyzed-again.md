# A revised posting whose analysis the time budget left was never analyzed again

The real workspace (read-only, 2026-11-27) had 6 postings whose match report was older than their current snapshot, none of them held for requirement labels.
DriveWealth (<run id>) was ANALYZING, revised at 2026-11-27T02:39:39Z, with a match from 2026-11-20.
Five Lightmatter postings (<run id>, <run id>, <run id>, <run id>, <run id>) were revised at 2026-11-26T14:37Z, with matches from 2026-11-20 and 2026-11-25.
Cause: `resumeDeferredAnalysis` (`packages/agent/src/discovery-orchestrator.ts`) took only DISCOVERED postings with no match, while a revision keeps its status and its old match, so a revision whose analysis a pass's time budget deferred was never analyzed again; `advancePipeline`'s leftover analysis has the same DISCOVERED-with-no-match rule.
Reading boards past the budget (Track 73) and Track 68's location heal, which is a revision, make this path common.
Fix (Track 73): the resume takes `listPostingsAwaitingAnalysis` (`packages/db/src/job-posting-repository.ts`): DISCOVERED with no match, or any status before the approval gate whose match predates its current snapshot, not skipped by feedback, not held for labels, oldest first.
Regression: `pnpm test:agent:pass` (`testing-harness/agent/pipeline-pass.integration.test.ts`, a revision deferred by the budget and resumed by the next pass) and `pnpm test:jobs:local` (`testing-harness/jobs/discovery.integration.test.ts`, the query's exclusions).
Live confirmation: the next real pass's "Deferred postings:" line counts these six, and their matches become newer than their snapshots.

## Refuted causes
- They were held for requirement labels. Evidence: no requirement_label_holds row for any of the six (real database, read-only, 2026-11-27).

fixture: modelled
