Review status and source freshness are independent.
Only `ALLOWED` plus `CURRENT` claims are verified.
A changed evidence fingerprint creates a pending revision; deleted supporting paths make the current revision stale.
Same-SHA sync is a no-op, and a new SHA fetches only selected blobs whose blob SHA changed.
