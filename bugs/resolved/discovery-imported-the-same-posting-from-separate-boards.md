# Discovery imported the same posting from separate boards

Discovery compared content only within one batch and looked up persisted jobs
by exact source URL. Two boards exposing the same company, title, and full
posting text under different URLs created two jobs. The batch repost key also
discarded distinct descriptions under one company and title. Reproduced in
disposable SQLite on 2026-09-23.

Fixed: discovery checks normalized company, title, and full posting text
against current snapshots before ingestion, and its batch key uses the same
identity. Duplicates count in the run and do not re-enter analysis or the
review queue. Distinct descriptions remain separate. Regressions:
`skips the same posting when two boards expose it under different URLs`,
`keeps distinct requisitions that share a company and title`, and
`keeps source-free postings from different companies even when their body text matches` in
`testing-harness/jobs/discovery.integration.test.ts`.
