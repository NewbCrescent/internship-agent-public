**Re-evaluating stored matches.**
Match verdicts are stored, so a matching change reaches stored postings through `pnpm matches:reevaluate --profile real|demo [--apply] [--job <id or 8-character prefix>]` (`packages/agent/src/match-reevaluation.ts`).
It re-runs `evaluateMatch`, the evaluation `evaluateAndPersistMatch` saves, for postings with a stored match, and prints the old → new verdict counts and the changed postings by company, title, and verdict, with a `MATCH_REEVALUATION_REPORT` JSON line.
A dry run is the default: it opens the database read-only and takes no lock; `--apply` takes the pipeline lock.
It never evaluates submitted or later postings, approved postings, postings the candidate skipped or closed (including "Posting closed"), applying postings with a browser run that is not cancelled, or postings held for AI requirement labels.
It writes only postings still in analysis (DISCOVERED, ANALYZING, QUALIFIED, NOT_QUALIFIED) whose status matches their stored verdict and that were never prepared or run; other changed verdicts are listed as left in place, so a posting closed by hand or an application in progress never moves.
`--apply` saves a changed verdict with `saveJobMatch`, which moves the status as an analysis does, and logs "Match re-evaluated by pnpm matches:reevaluate: <old> → <new>." on the posting's timeline; an unchanged verdict writes nothing.
Regressions: `testing-harness/matching/match-reevaluation.integration.test.ts` (`pnpm test:matching:reevaluate`).
