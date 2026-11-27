# Public boards were starved by the discovery time budget and never read by the watcher

The real workspace (read-only, 2026-11-27) had 211 enabled discovery sources, 206 of them public Greenhouse, Lever, and Ashby boards, all created on 2026-11-26 at 13:16Z.
155 of the 206 boards had never been read (`last_fetched_at` NULL).
The 51 boards that had been read were read once each, in five full passes: 9 boards (2026-11-26 13Z), 16 (11-26 14Z), 12 (11-27 00Z), 7 (11-27 02Z), and 7 (11-27 05Z); no board had more than one discovery run.
Full passes logged "Public boards: checked 7 (0 failed), not due 0, backed off 3, left for a later pass 103, left by the time budget 93." and "discovery: 93 boards and 46 postings left for the next pass (budget)." (19 and 4 postings in later passes).
The watcher journal (`journalctl --user -u com.internship-agent.watch.real.service`, 2026-11-20 to 11-27) shows no "Public boards:" line at all: each doorbell pass checked only the GitHub lists the doorbell rang for.
Pass 32's discovery runs show the order: the pass started about 05:17Z, resumed deferred postings until about 05:22, read the lists from 05:22 to 05:27:38, and started boards at 05:27:38, so the 15-minute budget ended about 05:32 after 7 boards.
Cause (a): boards come last in a pass, after the deferred-posting resume and the lists, so the time budget was usually spent after 5 to 16 boards, and a board past it was not started.
Cause (b): `runPipelinePass` (`packages/agent/scripts/pipeline-pass.ts`) filtered every source, boards included, by the doorbell's changed list ids, so the watcher's passes never checked a board; boards were read only by a manual `pnpm pipeline:run`.
At about 7 boards per full pass the 155 never-read boards needed about 22 full passes.
Consequence for Track 68's location heal: 208 stored postings with no stated location sit on 29 boards that were read once before Track 68 merged, and oldest-first ordering put their second read behind all 155 never-read boards.
Fix (Track 73): past the time budget a pass that checks sources still reads up to 20 due boards, oldest first (`BOARD_MIN_CHECKS_PER_PASS` in `packages/agent/src/board-polling.ts`, the floor in `checkPublicBoards` in `packages/agent/src/discovery-orchestrator.ts`), storing their new postings and leaving their analysis for a later pass, and boards past the floor stay due and go first next pass.
Fix (Track 73): every pass that checks sources, including the doorbell's, also checks the public boards that are due (`runPipelinePass`), while a quiet tick still runs nothing.
So every due board that is not backed off is read within ceil(position/20) passes that check sources.
`pnpm backfill:board-locations --profile real|demo [--apply]` re-reads, on demand, the boards of postings that still have no stated location.
Regression: `pnpm test:jobs:local` (`testing-harness/jobs/board-sources.integration.test.ts`, the board floor across passes) and `pnpm test:agent:pass` (`testing-harness/agent/pipeline-pass.integration.test.ts`, boards read past the budget and a doorbell pass reading due boards).
Live confirmation: a real pass that checks sources logs "read past the time budget N" or reads every due board, and a watcher pass logs a "Public boards:" line.

## Refuted causes
- The same boards are deferred on every pass. Evidence: planBoardChecks reads never-read boards first, then the oldest last fetch, a board the budget leaves keeps its last_fetched_at, and the real database (read-only, 2026-11-27) shows 51 distinct boards read once each in passes 26–33 and none twice.

fixture: modelled (synthetic boards, injected fetches, fake clock; the evidence was read-only from the real workspace and the watcher journal on 2026-11-27)
