# Dashboard ignored the root model settings

`MODEL_API_BASE_URL`, `MODEL_API_KEY`, and `MODEL_API_MODEL` are set only in
the repository-root `.env`, but `next dev` reads only `apps/dashboard/.env*`.
On 2026-09-23 the running dashboard process had no `MODEL_API_KEY`, so every
ingestion and board check from the app classified requirements
deterministically; the 70 recorded model invocations all came from scripts
that loaded `.env` explicitly. Passing Node's `--env-file-if-exists` to the
Next CLI fails because Next forwards it to workers through `NODE_OPTIONS`,
where Node rejects it.

Fixed: the dashboard's `dev`, `build`, and `start` scripts run through
`apps/dashboard/scripts/with-root-env.mjs`, which loads the root `.env`
(shell variables win) before launching Next. Verified by starting an owned
dev server on port 3107 with a temporary data directory and the model
variables unset in the shell: it served `/jobs` and its process carried
`MODEL_API_KEY`. The browser harness launches `next dev` directly and is
unaffected. This is a launch-path check, not an automated regression.
