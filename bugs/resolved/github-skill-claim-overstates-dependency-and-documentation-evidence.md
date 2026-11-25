# GitHub skill claim overstates dependency and documentation evidence

`extractSourceSignals` scans README and manifest files as well as source files,
then labels every match `Source contains implementation evidence for ...`.
In the 2026-09-22 temporary sync of `owner/sample-repo` at
`<commit>`, the Playwright claim had
three evidence items: a `package.json` test script and two testing-harness
README lines. None was an implementation file. Keep this claim pending; a
dependency or documentation mention should be described as such, and skill
claims should require matching implementation evidence.

Fixed: `extractSourceSignals` reads only `source` files, so README lines and
manifest scripts no longer produce "implementation evidence" claims; manifest
dependencies keep their own dependency claims. Regression: `claims
implementation evidence only from source files` in
`testing-harness/github/repository-contracts.test.ts`. Claims an older sync
already stored stay (as PENDING, never used by the writer) until their files
change or the repository is registered fresh; the sample sync above ran only
in a disposable database.
