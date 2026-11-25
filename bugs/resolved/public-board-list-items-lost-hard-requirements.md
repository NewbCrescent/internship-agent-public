# Public board list items lost hard requirements

The bounded five-source acceptance check on 2026-09-23 imported 28
Greenhouse/Lever postings with zero extracted requirements. Most public API
descriptions supplied encoded HTML list items, but the board text converter
turned each `<li>` into a newline. The requirement extractor recognizes
bullets, so explicit degree requirements disappeared. Five postings with
stated PhD requirements were then marked `QUALIFIED` against a profile that
did not establish doctoral study. Independently, the degree check could pass a
PhD requirement from matching subject words in a bachelor's degree.

Fixed: public board conversion preserves list items as bullet lines, and a
doctorate-only hard requirement yields `NEEDS_REVIEW` unless the recorded
degree establishes doctoral study. A stated lower-degree alternative can still
pass on its own evidence. Regressions: `preserves encoded HTML list items as
grounded requirement bullets` in
`testing-harness/jobs/github-list-source.test.ts` and `pauses on a
doctorate-only requirement when the profile records only a bachelor's degree`
in `testing-harness/matching/eligibility-fit.test.ts`.
