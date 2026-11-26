# Pauses and early stops saved no page capture

Found 2026-11-25 and 26 on the real workspace while tracing failed and
paused applications. Workday history-row pauses (Compassion <run id>),
failures before a run row was saved (the ZOLL 30 s locator timeout on job
<run id>), step transitions (Littelfuse's lingering hidden resume input),
pauses on sites with no adapter (Eightfold, whose markup Track 35 had to
guess), and "No application form was found" stops on career wrappers
(ViaSat's `?icims=1` page) saved no screenshot and no DOM, so their causes
were inferred. Cause: only submit clicks, Workday account, entry, and step
errors, iCIMS stops, and covering dialogs saved evidence. Fix (Track 42):
`saveStopEvidenceQuietly` (`packages/agent/src/submit-evidence.ts`) saves
one redacted capture, with a bounded excerpt of the page region read by
`readStopRegionIn` (`packages/browser/src/stop-evidence.ts`), the first
time each of six stop kinds happens in a run (at most five per run, 20 per
job), shown by `pnpm run:evidence`; and every real run records a
Playwright trace, kept only when the run does not end cleanly
(`packages/browser/src/run-trace.ts`). Regressions: the Track 42 blocks of
`pnpm test:agent:evidence`, `pnpm test:browser-worker:local`, and
`pnpm test:agent:retry`, and `xvfb-run -a pnpm test:browser:stop-evidence`.
Not verified: the real causes of the stops named above, which the next
real runs' captures should show.
