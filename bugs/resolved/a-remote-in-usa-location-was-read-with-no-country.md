# A Remote in USA location was read with no country

OpenSesame's Greenhouse posting (2026-11-26) stored "Remote" with no country
because its "Job list location: Remote in USA" line was one unreadable
segment and the following "Location: Remote" added nothing. The application
target therefore held it for review ("no country is stated"), and its
sponsorship question had no country to be scoped to. The target's location
rule was right; the parser was not. Now `readPlaceGroup`
(`packages/jobs/src/deterministic-extractor.ts`) strips a work-mode lead-in
("Remote in", "Remote within the", "Hybrid in") before reading the place, so
"Remote in USA" is a remote US location and `locationCountryCodes("Remote in
USA")` is US. Regression: `normalization-contracts.test.ts`
(`pnpm test:jobs:fast`). Stored postings keep their rows until
`pnpm backfill:extraction --apply` re-reads them (the manager's decision).
