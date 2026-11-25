Milestone 2 uses the versioned GitHub REST API through native `fetch`.
Public access needs no credential within GitHub's unauthenticated rate limit; an optional local `GITHUB_TOKEN` raises the read limit.
Repository code is never cloned or executed.
