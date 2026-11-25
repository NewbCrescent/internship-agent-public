# Continued runs kept stale pauses and could not keep Greenhouse multi-select choices

Found 2026-11-24 from the recorded evidence of a real Greenhouse run.
Continuing a held run never planned its open pauses again: a pause built by
older code (package prose offered to a racial/ethnic "mark all that apply"
list, not marked sensitive) stayed as it was, and a standing setting or a
saved self-identification answer added since never answered its pause. A
pause candidate memory now answered got a fill decision but stayed open, so
the run stayed held and the pause was still listed. A react-select
multi-select ("mark all that apply") shows the choice as a chip, not a single
value, so the fill was reported as "the page did not accept the value"; and
the pause that replaced a failed demographic fill lost its sensitive flag.
Continue now plans every open, unanswered pause with today's rules and marks
a pause memory or a rule answers as answered (without copying a protected
option), the chip counts as the kept choice, and a failed demographic fill
stays sensitive. The multi-select markup is react-select's standard isMulti
markup, assumed for Greenhouse and not captured. Regressions: the "continuing
a held run" tests in
`testing-harness/browser-worker/self-identification.integration.test.ts`
(`pnpm test:browser-worker:local`), the unfilled-pause test in
`testing-harness/browser-worker/consent-and-facts.test.ts`
(`pnpm test:browser-worker:fast`), and
`testing-harness/browser/greenhouse-demographics-run.ts`
(`pnpm test:browser:greenhouse-demographics`).
