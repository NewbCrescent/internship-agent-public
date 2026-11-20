# Internship Agent Testing Harness

Use the smallest tier that crosses the changed behavior's real boundary.

```bash
pnpm agent:doctor --feature profile
pnpm agent:verify
pnpm agent:finish profile
pnpm verify:fast
pnpm verify:local
pnpm verify:browser
pnpm verify:feature -- remember
pnpm verify:feature -- github
pnpm verify:feature -- jobs
pnpm verify:github:real -- --repo owner/repository
pnpm verify:jobs:corpus
pnpm corpus:build --limit 24 --per-feed 6
node testing-harness/run.mjs --list
```

The manifest records feature labels, prerequisites, network use, mutations, timeouts, and report prefixes. Fast checks are deterministic. Local checks create disposable SQLite databases. Browser checks own their server, port, and temporary data directory. No ordinary tier contacts an external provider or a model.

`corpus:build` is a data-preparation utility rather than a verification suite,
so it has no manifest entry and no tier. It performs third-party reads and
writes only into the Git-ignored corpus directory.

Both benchmark suites are explicit and never selected implicitly. Real GitHub acceptance is read-only and still leaves claim approval to the candidate. The posting corpus reads the Git-ignored `data/job-postings/` directory, may use a configured model, and reports what the classifier decided without asserting that it is correct — judging a hard/preferred split remains a human review step.

Safety assertions worth preserving include: a hard requirement can never be inferred, an extracted span must resolve against its stored snapshot, a classifier cannot introduce or move a span, and an unstated constraint stays null rather than becoming a decision.

Add reusable edge cases to the nearest suite. Do not weaken a safety assertion to make a run pass, and do not treat synthetic fixtures as evidence of production accuracy.
