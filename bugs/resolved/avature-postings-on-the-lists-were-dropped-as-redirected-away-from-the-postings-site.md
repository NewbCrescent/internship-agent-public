# Avature postings on the lists were dropped as redirected away from the posting's site

Found 2026-11-26 on the real workspace: Total Quality Logistics "Software Development Intern" (Cincinnati, OH) was on the Simplify list at age 0d and was never stored.
The list was read correctly and the row passed the age filter; its link `tql.avature.net/en_US/TQLexternalcareers/JobDetail/<id>` went to the generic schema.org career-page source.
`tql.avature.net` answers with a 301 to `careers.tql.com` on the same path, which serves the posting's schema.org JobPosting, but the generic page source followed only same-host redirects.
Every Simplify pass logged the four TQL rows under "redirected away from the posting's site" among the postings left for manual review, and none was stored.
Of the 69 Simplify rows within the 3-day age limit on 2026-11-26, 15 were not stored: 6 on `*.avature.net` (4 TQL, 1 ManTech, 1 Jack Henry), 2 on `amazon.jobs`, and one each on `careers.itw.com`, `lifeattiktok.com`, `www.tesla.com`, `recruiting2.ultipro.com`, `csptest2025.applytojob.com`, Ashby, and Greenhouse; the last real pass gave "redirected away" 5, "no schema.org JobPosting data" 6, HTTP 403 1, no public Greenhouse board 1, request failed 1, and unsupported host 1.
Fix: the generic page source now follows one move to another public, non-excluded host that keeps the same path (`fetchHtml` in `packages/agent/src/posting-page-sources.ts`); path changes such as sign-in bounces, ATS and aggregator hosts, reserved names, and a second move are still refused, and the stored URL stays the listed link so later checks see it as already known.
Auto-submit is unchanged: such postings are an unrecognized site and still wait for the candidate's approval.
Every listed row now also gets a decision in the discovery trace (`docs/technical/06-job-posting-model/385-discovery-trace.md`), so a dropped row can be found with `pnpm discovery:trace --find <text>`.
Regression: the Avature same-path move test in `testing-harness/jobs/posting-sources.test.ts` (`pnpm test:jobs:fast`).
Not verified live: the other Avature tenants (ManTech, Jack Henry, Koch, MetLife) and the Vansh short links, whose destinations were outside the investigation's clearance.
