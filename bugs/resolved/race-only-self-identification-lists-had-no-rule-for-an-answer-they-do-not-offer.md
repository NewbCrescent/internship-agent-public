# Race-only self-identification lists had no rule for an answer they do not offer

Found on 2026-11-26 while reviewing two Rippling forms that ask "Please identify your race" with race categories and "Choose not to disclose" but no Hispanic or Latino option.
Cause: `matchSelfIdentificationOption` in `packages/browser/src/ats/self-identification.ts` fills a protected question only when exactly one offered option matches, so any saved race or ethnicity answer such a list does not offer left the question paused, and the candidate had not decided what such a list should get.
Decision: the candidate chose "Choose not to disclose" (2026-11-26), recorded in the sensitive-facts invariant of `AGENTS.md`.
Fix: on a race-only question (not a combined race-or-ethnicity or Hispanic/Latino question) with no matching option and exactly one decline option, the matcher chooses that decline option, and the decision's reason names only the rule, never the saved answer.
Regressions: the race-only cases in `pnpm test:browser-worker:fast` and `pnpm test:browser-worker:local`.
