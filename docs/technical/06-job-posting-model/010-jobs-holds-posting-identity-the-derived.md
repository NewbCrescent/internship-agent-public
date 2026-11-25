`jobs` holds posting identity, the derived application type, and the full application state machine.
`job_snapshots` stores the immutable normalized posting text; re-ingesting identical content is a no-op, and changed content supersedes the prior snapshot and re-derives every dependent row in one transaction.
A stored posting retains its source URL as its revision key.
Discovery also checks current snapshots across URLs: matching normalized company, title, and full posting text is counted as a duplicate and is not ingested or analyzed again.
Distinct descriptions under one company and title remain separate postings.
Dashboard posting lists and overview counts include only jobs with a current snapshot, so legacy pre-normalization placeholders are retained without being parsed as postings.
