# Discovery used up the whole pass and no application step ran

Found in real pass 24 (2026-11-26): the pass checked about 25 public boards, reached its 3,500-second limit while still in discovery, and never started a browser run.
Cause: discovery analyzed and prepared every new posting inline, and its AI fit ran one posting at a time at about 25 seconds each; the real database's model calls from 13:30Z to 14:50Z show 107 `job.semantic_fit` calls (88 succeeded, 19 failed) and 335 `job.requirement_classification` calls, the latter made concurrently during ingest.
Fix: each pass now has a discovery time budget (`INTERNSHIP_AGENT_DISCOVERY_BUDGET_MS`, default 15 minutes, `packages/agent/src/discovery-time-budget.ts`) checked before each new posting's analysis and before each public board's fetch.
A posting past the budget stays stored as DISCOVERED with no match, a board past it is not started and stays due, and the pass always goes on to its application step.
The next pass that checks sources first resumes the deferred postings, oldest first, through the same analysis and preparation (`resumeDeferredAnalysis` in `packages/agent/src/discovery-orchestrator.ts`).
In these passes `advancePipeline`'s analysis of leftover DISCOVERED postings is turned off (`analyzeLeftovers: false`), so no deferred posting is prepared or run before its AI fit.
Regressions: the two Track 58 cases in `pnpm test:agent:pass` (the budget setting and clock contract, and a two-pass deferral and oldest-first resume on a fake clock).

## Refuted causes

- Board fetching was the bottleneck. Evidence: model_invocations 2026-11-26 13:30Z–14:50Z: 107 job.semantic_fit calls averaging about 25 s, made one at a time, against board fetches bounded to four at a time by Track 52.

fixture: modelled (fake list fetch, fake clock, no model; the real pass's timing was measured read-only from the real database)
