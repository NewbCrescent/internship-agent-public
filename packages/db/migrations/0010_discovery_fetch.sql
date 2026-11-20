-- The M9 rate limiter created a fresh bucket per call, so the limit never
-- tripped across calls. Persist the last fetch per source; the minimum
-- interval derives from rate_limit_per_minute at read time.
ALTER TABLE discovery_sources ADD COLUMN last_fetched_at TEXT;
