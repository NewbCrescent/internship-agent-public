# The blocker board went stale between manual runs

Found 2026-11-26 on the real workspace: the scoreboard snapshots under
`<workspace data>/scoreboard/` jumped from 12:43Z to 23:49Z while about 100
automatic watcher passes ran, so the blocker board (blockers by kind,
applications held, claims) showed the state of the last manual
`pnpm pipeline:scoreboard` run, not of the last pass. Cause: only the
scoreboard command built and saved the board; neither `pnpm pipeline:run`
nor the watcher's pass (`runPipelinePass` in
`packages/agent/scripts/pipeline-pass.ts`) did. Fix (track 61): every pass
ends, after its hold refresh, with `refreshScoreboardSnapshot`
(`packages/agent/src/pipeline-scoreboard.ts`), which builds the board with
the command's `buildScoreboard`, saves its snapshot, and prunes the folder,
and logs one `Board:` line (held count, top three blockers, whether the
snapshot was saved). A board that cannot be built or saved is one log line
and never fails the pass; nothing goes to Discord. Since a snapshot is now
saved per pass, pruning keeps the newest 200 snapshots on top of the
existing 30-day window. Regressions: the track 61 cases in
`pnpm test:agent:pass` and `pnpm test:agent:scoreboard`, on temporary
SQLite workspaces. Not verified live: the board's build time on the real
workspace.

fixture: modelled

## Refuted causes

- Pruning removed the snapshots between 12:43Z and 23:49Z. Evidence: `pruneScoreboardSnapshots` at <run id> removed only snapshots more than 30 days old, and no code path other than `pnpm pipeline:scoreboard` wrote one.
