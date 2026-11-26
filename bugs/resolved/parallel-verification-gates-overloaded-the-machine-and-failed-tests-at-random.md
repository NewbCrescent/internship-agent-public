# Parallel verification gates overloaded the machine and failed tests at random

Found on 2026-11-26 while four or five fix tracks ran `pnpm agent:finish`
and browser suites in parallel worktrees on one machine: the load average
reached about 12, and Vitest's 5 s per-test timeouts failed at random in
run-lifecycle, continued-auto-submit, and automatic-retry, which cost
whole reruns and false fails. Cause: nothing limited how many heavy gates
ran at once across worktrees. `agent:finish`, and each browser-tier suite
the harness runner starts, now first take one of a small number of
machine-wide gate slots (`INTERNSHIP_AGENT_GATE_SLOTS`, default 2) from
lock files in the per-user temp directory
(`testing-harness/support/gate-slots.mjs`), wait for one without a
timeout while printing who holds them every 30 s, reclaim slots left by
dead processes, and release theirs on exit, error, SIGINT, and SIGTERM;
`--no-wait` skips the slot. Fast-tier and local-tier suites run alone
through pnpm take no slot, and no test or timeout was loosened.
Regression: `testing-harness/harness/gate-slots.test.mjs` (`pnpm
test:harness`): take and release, a third waiter blocked until a release,
stale-lock reclaim, and release on a thrown error, an uncaught error, and
SIGTERM; it fails on the old code, which had no gate-slot module. Not
verified: the load reduction itself under a real multi-track run.
