Heavy gates share a machine-wide limit, because parallel worktrees running `agent:finish` and browser suites at once overloaded the machine and made Vitest's 5 s per-test timeouts fail at random.
`testing-harness/support/gate-slots.mjs` is a counting semaphore of lock files in the per-user temp directory (`os.tmpdir()/internship-agent-gates-<uid>`, owner-only), shared by every worktree and never inside a repository.
`INTERNSHIP_AGENT_GATE_SLOTS` sets the number of slots (default 2, 1–32); any other value stops the gate with an error.
`agent:finish` holds one slot for all its steps, and passes `INTERNSHIP_AGENT_GATE_SLOT_HELD` to its children so the nested verification runner reuses the slot instead of taking a second one.
The harness runner (`testing-harness/run.mjs`, behind `agent:verify`, `verify:browser`, and `verify:feature`) takes a slot for each browser-tier suite it starts, and the wait does not count against the suite's timeout.
Fast-tier and local-tier suites, and any `test:*` script run alone through pnpm, take no slot.
Each slot file is created atomically with a hard link and records the owner's pid, its process start time, the start time, the label, and the working directory.
A slot whose pid is dead, or whose pid now names a process with a different start time, is reclaimed under a per-slot reclaim lock, and only if the file still holds the record judged stale.
A waiting gate prints `waiting for a gate slot: N in use by pids …` at once and then every 30 s, and waits without a timeout.
`--no-wait` (`pnpm agent:finish <feature> --no-wait`, or `node testing-harness/run.mjs … --no-wait`) runs without a slot.
The slot is released when the gate ends, when it throws, and on SIGINT or SIGTERM, which are passed on to the running step before the gate exits with 128 plus the signal number.
Pass and fail exits and the `AGENT_FINISH_REPORT` and `HARNESS_RUN_REPORT` lines are unchanged, and no test or timeout was loosened.
Its regressions are in `testing-harness/harness/gate-slots.test.mjs`, run by `pnpm test:harness` under the `agent-workflow` suite.
