The deny-list holds the only copy of the real names, so it never enters either repository.
Regressions: `testing-harness/harness/public-sync.test.mjs` (`pnpm test:harness`) with a fictional deny-list: replacement, run-id masking, fail-closed scans, and the clone sync.
