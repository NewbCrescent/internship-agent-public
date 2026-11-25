# An answered select was typed into on continue

`continueBrowserRun` turned every answered pause into a `fill` decision, so
an answered select or radio question was sent to `fillField`, which Playwright
refuses on a `<select>`, and the continued run failed on real forms. Found
2026-11-19 (run H). Now an answer matching exactly one offered option is
chosen, a single checkbox answered yes is checked and one answered no is left
unchecked, a text answer fills as before, and an answer that fits no option of
its list reopens the pause instead of being typed into the list. Regressions:
"chooses an answered select and leaves an answered-no checkbox on continue" in
`testing-harness/agent/question-answers.integration.test.ts`, and "chooses an
answered list option on continue, and reopens an answer that is not among the
options" in `testing-harness/browser-worker/run-lifecycle.integration.test.ts`.
