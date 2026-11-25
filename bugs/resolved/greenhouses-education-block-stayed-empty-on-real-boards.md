# Greenhouse's education block stayed empty on real boards

After run N, fresh automatic runs on 2026-11-20 still paused on School,
Degree, Discipline, and a date month: Ironvale (<run id>), Glowpath
(<run id>), and Tidewave (<run id>). A read-only capture showed the real ids
match run N's rule; the lists are async catalogs, and the school catalog
spells campuses "University of California - Berkeley", which a typed
"University of California, Berkeley" never equalled. On a local replica the
failed School search also left its menu open (Escape, then an empty fill
reopened it), absolutely positioned over Degree, Discipline, and the start
month, so their clicks timed out. Now a suggestion with exactly the same
words (punctuation, case, accents, and of/the/at/and/in ignored) is taken,
one at most; every list choice starts with no menu open; a failed search is
cleared, closed, and left without focus; and the catalog lists get longer to
load. Regressions: `recognition-planner.test.ts` (`matchSuggestion`),
`application-history.test.ts` (`sameNameKey`), and the Greenhouse scenarios
of `pnpm test:browser:greenhouse` (the "System - Campus" school, and a
no-match school that leaves only School unfilled).
