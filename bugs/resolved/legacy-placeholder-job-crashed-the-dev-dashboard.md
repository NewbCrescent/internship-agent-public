# Legacy placeholder job crashed the dev dashboard

A Milestone 0 `jobs` row with ID `seed-internship` survived the posting-schema
migration without a current snapshot. The dashboard list projected it through
the UUID-backed `jobSummarySchema`, raising `Invalid UUID` on dev startup.
Confirmed against the local database on 2026-09-22.

Fixed: posting lists and overview counts include only jobs with a current
normalized snapshot. The legacy row remains in the database. Regression:
`ignores pre-normalization placeholder jobs that have no captured snapshot`
in `testing-harness/jobs/ingestion.integration.test.ts`.
