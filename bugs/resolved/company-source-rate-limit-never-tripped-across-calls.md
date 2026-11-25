# Company-source rate limit never tripped across calls

`fetchCompanySource` built a fresh in-memory rate-limiter bucket on every
call, so the per-minute limit only applied within a single call and never
across polls. Found by simulation review 2026-09-22.

Fixed: the last attempt persists on `discovery_sources.last_fetched_at`
(migration `0010_discovery_fetch.sql`); the minimum interval derives from
`rate_limit_per_minute` at read time, and the reservation occurs before network
I/O, including failures. Regression: the company-source fetch test asserts an
immediate second poll is refused without fetching.
