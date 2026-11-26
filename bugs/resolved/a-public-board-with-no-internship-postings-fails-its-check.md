# A public board with no internship postings fails its check

Found on 2026-11-26 while planning Track 52 (code reading, no live run).
Cause: `fetchPublicBoard` returns no items for a board whose listing has no
internship titles (or none with a usable description), and
`processDiscoveredItems` throws "The batch held no usable postings." for a
source that reports no notes.
Effect: every check of such a board was logged as an error, and with hundreds
of imported boards, most without a current internship posting, each pass would
have been flooded with errors.
Fix: the public board branch of `defaultFetchBatch` returns the note "No
internship postings on this board right now." when it finds nothing, so the
check finishes as an empty run without loading every stored posting.
Regression: `testing-harness/jobs/board-sources.integration.test.ts`
(`pnpm test:jobs:local`), the empty-board case.

fixture: modelled (a synthetic Greenhouse board answer with only a non-internship title; no live board was checked)
