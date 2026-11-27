# Public board postings were stored without their location

Real pass 31 (2026-11-27) held FUTO's "Software Engineer - Internship 2027" (<run id>) and Garda Capital Partners' "Software Engineer Intern (C#)" (<run id>) and "Infrastructure Engineer Intern" (<run id>) with "Location: no country is stated, so it is not sent automatically.", and pass 27 held Esri's "Software Development Internship" (<run id>) the same way.
All four came from imported public company boards, and their stored snapshots carried no `Location:` line and no job_locations rows.
Cause: `fetchPublicBoard` (`packages/agent/src/public-board-source.ts`) read only each job's title, link, description, and publication date, so it dropped Greenhouse's `location` and `offices`, Lever's `categories` and `country`, and Ashby's `location`, `address`, and `secondaryLocations`, and wrote no `Location:` line, while the boards' public APIs state "Austin, TX" with country US (FUTO), "Wayzata, Minnesota, United States" (Garda Capital Partners), and "Redlands, CA" (Esri).
Scale: 213 stored Greenhouse, Lever, and Ashby postings had no location line and no country on 2026-11-26.
Fix (Track 68): the board path writes the same `Location:` and `Office:` lines as the GitHub list's resolvers, through `ashbyLocation`, `leverLocation`, `greenhouseOfficeLine`, and `withLocation` in `packages/agent/src/place-text.ts`, also for oversized boards read posting by posting or in pages, and an unexpected location shape on one job never fails the board.
Stored postings are re-read with their location on their board's next check, because the new line changes the posting text, except postings past the approval gate (APPROVED and later, including the 3 APPLYING ones), which keep no country.
That next check waited behind 155 never-read boards until Track 73, which also adds `pnpm backfill:board-locations` to re-read their boards on demand; the APPLYING ones still need a requeue first.
`pnpm backfill:extraction` does not help these postings, because their stored snapshots hold no place.
Regression: `pnpm test:jobs:local` (`testing-harness/jobs/discovery.integration.test.ts`).
Two other postings held with the same reason have other causes.
Threadline Studio's "Software Engineer Intern" (<run id>) was stored with "Location: Seoul" before Track 58, and the current extractor reads it as KR, so `pnpm backfill:extraction --profile real --apply`, after a database backup, would let the existing rule skip it.
SkillSecure X's "Full Stack Web Developer Intern (Remote)" (<run id>) states only the Dover region "International" and remote work, so it truly names no country and is held on purpose.

## Refuted causes
- The target's location rule is too strict for these postings. Evidence: FUTO's Lever API states "Austin, TX" with country US, Garda's Greenhouse API "Wayzata, Minnesota, United States", and Esri's "Redlands, CA" (read 2026-11-26), while their stored snapshots (captured 2026-11-27) carry no Location line and no job_locations rows.
- The extractor cannot read these places. Evidence: extractDeterministically reads "Location: Austin, TX, United States", "Location: Wayzata, Minnesota, United States", and "Location: Redlands, CA" as US (read-only run, 2026-11-26).
- A pending `pnpm backfill:extraction` would fill them. Evidence: the backfill re-reads stored snapshot text, and FUTO's whole stored snapshot (270 characters) and Garda's and Esri's name no place outside prose.

fixture: captured 2026-11-26 (the location, offices, categories, country, and address field shapes of the FUTO, Garda Capital Partners, Esri, and Threadline Studio public posting API answers, read-only; the tests use fictional names)
