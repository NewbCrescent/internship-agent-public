# Public boards over 5 MB were never read

Ironvale (Greenhouse), Veeva Systems (Lever), and Shield AI (Ashby) failed every check with "The public board response is too large to process safely." and were backed off for 12 hours each time.
Read-only measurements on 2026-11-26: Ironvale's board was 45.9 MB with `?content=true` and 2.74 MB without it, 2,598 jobs and 43 internship titles; Veeva Systems' was 12.4 MB, 874 jobs and 7 internship titles, about 1.36 MB per page of 100; Shield AI's was 9.9 MB, 686 jobs and 22 internship titles.
Ashby's public posting API offers no paging, no filters, and no content-free list.
Fix (`packages/agent/src/public-board-source.ts`): a Greenhouse board over 5 MB is read again as its content-free job list plus one request per internship title, one at a time, at most 120 requests and 120 seconds per board.
A Lever board over 5 MB is read again in pages of 100, at most 20 pages, keeping text only for internship titles.
An Ashby board's answer may be up to 16 MB.
Normal-size boards keep their single request and endpoints.
Regressions: the three Track 58 cases in `pnpm test:jobs:local` (an oversized Greenhouse board, an oversized Lever board, and an Ashby answer up to 16 MB).

## Refuted causes

- A Lever commitment filter (`commitment=Internship`) would find a board's internships. Evidence: live read-only fetch 2026-11-26: commitment names are chosen per company, and Veeva's Internship commitment also holds a posting without an intern title, so the title rule and paging were kept.

fixture: modelled (synthetic Greenhouse, Lever, and Ashby answers shaped like the live read-only fetches of 2026-11-26)
