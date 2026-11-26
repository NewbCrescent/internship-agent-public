# Known answers on Veeva's Lever form and OpenSesame's Greenhouse form paused

The two Veeva Systems runs on Lever and the OpenSesame run on Greenhouse
(2026-11-26) paused on questions the candidate's saved answers settle: the
unrestricted right to work in the United States (no rule mapped it), the
sentence label "Please select your field of study:" and its list of broad
categories, the sentence label "Please specify the overall average grade
(GPA) for your last/current degree:", graduation-term options ("Spring
2027", "December 2028 or later"), the current-student question, and a
country list for "Where are you currently located?". A GPA with more
decimals than a list's bounds could also fall between two ranges ("3.295"
between "3.0 - 3.29" and "3.3 - 3.69") and match none. Now the mapper maps
the unrestricted right to work to the derived
`unrestricted_us_work_authorization` (`packages/agent/src/question-mapper.ts`,
`packages/agent/src/standard-answers.ts`) and the current-student question
to `enrolled_full_time` as a broader question answered only by a saved Yes
and never saved (`packages/agent/src/candidate-service.ts`,
`packages/agent/src/question-answers.ts`); the planner reads the
sentence-style GPA and field-of-study labels, reads a GPA truncated to each
option's decimals when it matches no range, picks the category naming the
field of study (`fieldOfStudyCategoryOption`,
`packages/domain/src/application-history.ts`), and answers a country list
from the profile address's country (`packages/browser/src/autofill-planner.ts`);
and a saved graduation date picks its term option (`graduationTermOption`,
`packages/domain/src/fact-options.ts`). Regressions:
`question-mapper.test.ts` (`pnpm test:agent`),
`memory-service.integration.test.ts` (`pnpm test:memory`),
`fact-options.test.ts`, `application-history.test.ts`, and
`standard-answers.test.ts` (`pnpm test:domain`), and
`recognition-planner.test.ts` (`pnpm test:browser-worker:fast`).
