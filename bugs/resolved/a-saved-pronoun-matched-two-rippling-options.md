# A saved pronoun matched two Rippling options

On APEX Analytix run <run id> and Forterra run <run id> (2026-11-26) Rippling's Pronouns list paused with "no suggestion matched" although the candidate's pronouns are saved.
Rippling offers each pronoun set alone and combined with "they/them/theirs" ("She/her/hers" and "She/her/hers, they/them/theirs"), so saved pronouns naming one set started two options, no option was picked, and the saved text itself was typed and matched two suggestions.
Fix: when saved pronouns naming one set start more than one option, only the options naming one set count, and exactly one is chosen (`matchPronounOption`, `packages/browser/src/autofill-planner.ts`); saved pronouns naming two sets are never narrowed to one.
The list itself is now chosen by clicking its option (Track 37's bare-list rule), so nothing is typed into it.
Regressions: scenario (h) of `pnpm test:browser:unrecognized-forms` (`fixtures/rippling-application.html`) and the pronoun case in `pnpm test:browser-worker:fast`.
