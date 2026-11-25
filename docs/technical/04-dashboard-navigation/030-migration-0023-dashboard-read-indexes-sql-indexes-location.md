Migration `0023_dashboard_read_indexes.sql` indexes location, latest-resume, posting order/status, and recent-event reads.
Pipeline counts use a SQL aggregate rather than materializing summaries; Applications reuses its outcome statistics for recommendations.
The root loading boundary shows navigation feedback, and the shell's profile cookie read has its own Suspense boundary so navigation links can render independently.
Jobs retains its existing 50-card page and publication-age filter.
