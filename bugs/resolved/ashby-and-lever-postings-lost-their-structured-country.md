# Ashby and Lever postings lost their structured country

"No country is stated" held Brightlane (Ashby location "Hybrid"), Threadline
Studio (Lever "Seoul"), and Fernwave Sciences (Ashby "South San
Francisco"), while Solvik ("Berlin") and Cloudrise ("Paris") were started
instead of ruled out. Discovery passed only the location string, dropping
Ashby's postal address and Lever's country code, and the extractor never read
a bare city. Now Ashby's address, Lever's country, and Greenhouse's offices join
the `Location:` line, a short table of unambiguous well-known cities decides
when nothing else is stated ("City, ST" and countries win), and the list's
column is added when the board's location names no place. Postings stored
before the fix keep their old snapshot until `pnpm backfill:extraction`.
Regressions: `testing-harness/jobs/github-list-source.test.ts` and
`normalization-contracts.test.ts`.
