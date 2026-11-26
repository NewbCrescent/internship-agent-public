Stop captures and run traces stay under the profile's data directory (`stop-evidence/` and `run-traces/` in each job's application folder, and `trace-artifacts/`), with directory mode 700 and file mode 600.
They are git-ignored (`data/*`, plus `run-traces/`, `stop-evidence/`, `trace-artifacts/`, and `trace-*.zip` anywhere), so they never reach the public mirror, which exports tracked files only.
They are never sent to Discord, logs, a model, or a report; the timeline names only their path relative to the data directory.
A stop capture may hold the screenshot and the visible text redacted like post-submit evidence, and never an input's value, a hidden token, a cookie, a header, the account email or password, or a history row's company or school.
A run trace may hold screenshots and the values the agent typed into the form (candidate details), and never network requests or responses, cookies, headers, storage, DOM snapshots, passwords, verification links, or emailed codes.
