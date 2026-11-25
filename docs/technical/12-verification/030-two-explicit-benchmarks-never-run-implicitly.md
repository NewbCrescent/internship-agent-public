Two explicit benchmarks never run implicitly:

- `pnpm verify:github:real -- --repo owner/repository`
- `pnpm verify:jobs:corpus`, which reads posting JSON files from the Git-ignored `data/job-postings/` directory. `pnpm corpus:build` populates that directory by resolving listing-repository links through the Greenhouse, Lever and Ashby public job-board APIs, because those repositories index postings without carrying their text (override with `INTERNSHIP_AGENT_POSTING_CORPUS`). It asserts structural reliability and reports what the classifier decided; it never treats model output as ground truth. Judging whether a hard/preferred split is correct remains a human review step.
