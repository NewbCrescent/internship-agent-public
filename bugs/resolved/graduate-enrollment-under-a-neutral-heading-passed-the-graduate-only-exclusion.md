# Graduate enrollment under a neutral heading passed the graduate-only exclusion

Example Analytics' "Quant Developer Intern" (2026-11-17) listed "Current
students pursuing a master's degree in mathematics, Physics, Financial
Engineering, Quantitative Finance, or a related quantitative field." under
"Education and Experience:". With no hard cue in the line or heading the
extractor left it PREFERRED (confidence 0.4), and the exclusion read only HARD
lines, so the posting was QUALIFIED for a bachelor's candidate who excludes
graduate-only internships. The exclusion now also reads such a defaulted line
when it states current graduate enrollment and has no preference wording
(`defaultedEnrollmentStatement` in `packages/matching/src/eligibility.ts`);
a Preferred heading or "preferred" wording keeps it soft. Regression:
`testing-harness/matching/eligibility-fit.test.ts`.
