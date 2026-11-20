-- Workday accounts are per career site, so browser_sessions now holds one
-- row per connected Workday site (`workday:{host}/{site}`) beside Handshake.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Still only
-- a status and a short detail: never credentials, cookies, or page content.
CREATE TABLE browser_sessions_next (
  site TEXT PRIMARY KEY CHECK (site = 'handshake' OR site GLOB 'workday:*.myworkdayjobs.com/*'),
  status TEXT NOT NULL CHECK (status IN ('connected', 'signed_out', 'unknown')),
  detail TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
INSERT INTO browser_sessions_next (site, status, detail, checked_at)
  SELECT site, status, detail, checked_at FROM browser_sessions;
DROP TABLE browser_sessions;
ALTER TABLE browser_sessions_next RENAME TO browser_sessions;
