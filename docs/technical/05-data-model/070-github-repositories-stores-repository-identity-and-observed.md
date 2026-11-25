`github_repositories` stores repository identity and observed/analyzed SHAs.
`repository_files` stores the current bounded selection's blob and content hashes.
`projects` owns stable project profiles.
`evidence_items` stores immutable commit/path/line/excerpt provenance.
Stable `claims` point to append-only `claim_revisions`, and `claim_review_events` records explicit allow/question/reject decisions.
