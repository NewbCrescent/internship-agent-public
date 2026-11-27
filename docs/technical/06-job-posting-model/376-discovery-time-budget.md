**Discovery time budget.**
Each `pnpm pipeline:run` and watcher pass gives discovery a wall-clock budget, `INTERNSHIP_AGENT_DISCOVERY_BUDGET_MS` in whole milliseconds, default 15 minutes, clamped to 1 minute to 6 hours, and any other value falls back to the default (`packages/agent/src/discovery-time-budget.ts`).
Real pass 24 (2026-11-26) checked about 25 boards, analyzed and prepared every new posting inline with the AI fit taking about 25 seconds per posting one at a time, reached its 3,500-second limit, and never started a browser run.
The pass checks the budget at two points: before each new posting's analysis (match, AI fit, promotion, and preparation), and before each public board's fetch.
A posting past the budget stays stored as DISCOVERED with no match, and a board past it is not started once 20 boards have started in the pass (see **Imported public boards**), so it keeps its `last_fetched_at`, stays due, and goes first in the next pass's oldest-first plan.
GitHub lists are always checked and their postings stored, so the doorbell state the watcher saves after a pass never loses a list's postings; only their analysis waits.
Work already in flight finishes: an AI fit call in progress completes, and boards already fetching (at most four) store all their postings, which are then left unanalyzed.
A source's line gains "N left for the next pass (budget)." after its prepared count, the boards summary gains "left by the time budget N", and the pass logs `discovery: N boards and M postings left for the next pass (budget).` before its application step.
A pass that checks sources first resumes the postings earlier passes left (DISCOVERED with no match, or a revision before the approval gate whose match predates its current snapshot (Track 73), not skipped by feedback, not held for labels), oldest first, through the same analysis and preparation as new postings and within the same budget, and logs "Deferred postings: N from earlier passes; analyzed A, prepared P, still waiting W." (`resumeDeferredAnalysis` in `packages/agent/src/discovery-orchestrator.ts`).
In these passes `advancePipeline` does not analyze DISCOVERED postings itself (`analyzeLeftovers: false`), so no deferred posting is prepared or run before its AI fit.
A `--skip-discovery` pass and `pnpm pipeline:retry --start` neither resume nor analyze them; they wait for the next pass that checks sources.
The dashboard's Check board and pasted batches have no budget.
Fit, target, promotion, and auto-submit rules are unchanged; only when a posting is analyzed changes.
