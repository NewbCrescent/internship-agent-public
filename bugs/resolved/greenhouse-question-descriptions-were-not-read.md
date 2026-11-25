# Greenhouse question descriptions were not read

Ironvale (<run id>) asks "HISTORY WITH IRONVALE" and "CONFLICT OF INTEREST" as
short headings with the question itself in a `<id>-description` block, so the
labels named no question. Now a short label with no "?" takes its
description when the description is a question ("HISTORY WITH IRONVALE: Have
you previously applied to a position at Ironvale?"). Having applied before is
not having worked there, so it stays paused; conflict of interest stays
paused. Regressions: `question-mapper.test.ts` and the Greenhouse scenario of
`pnpm test:browser:greenhouse`.
