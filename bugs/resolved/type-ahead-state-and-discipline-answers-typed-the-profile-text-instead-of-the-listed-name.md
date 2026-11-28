# Type-ahead state and discipline answers typed the profile text instead of the listed name

Abridge <run id> "Which state do you currently reside in?" typed the profile's "CA"; the trace shows the suggestions "Canada", "California, United States", "Cape Verde", …, none of which matched "CA".
Mach Industries <run id> Greenhouse "Discipline" typed "Computer Science"; its 79 read options hold only "Engineering - Computer Science / Software".
Cause: a profile contact value was typed into a type-ahead as stored, although the site's suggestions name it differently.
Fix (Track 83): a two-letter U.S. state code types the state's name ("California"), except in a "State Abbreviation" box, and a field-of-study type-ahead with read options types the one option naming the field's category (`typeAheadText` in `packages/browser/src/autofill-planner.ts`).
Regression: `pnpm test:agent` (`testing-harness/agent/held-question-corpus-track83.test.ts`).
fixture: captured 2026-11-28 (Abridge <run id> trace suggestion texts; Mach Industries <run id> stored Discipline options)
