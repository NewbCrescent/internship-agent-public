# The Vansh list never produced a posting

Every row of `vanshb03/Summer2027-Internships` links through `go.vansh.nyc`
short links (all 2,459 active rows on 2026-11-17), which the board resolver did
not recognize, so each was counted as needing manual review. Discovery now
follows a Vansh short link one redirect, without following it further, and
resolves the board link it names. Regression:
`testing-harness/jobs/github-list-source.test.ts`.
