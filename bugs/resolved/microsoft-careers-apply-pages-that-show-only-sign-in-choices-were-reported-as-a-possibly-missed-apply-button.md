# Microsoft Careers apply pages that show only sign-in choices were reported as a possibly missed Apply button

Found 2026-11-27 in Track 70's triage of the "No application form was reached at <site>" blocker (bd5ac093230).
Four Microsoft research-intern runs (<run id>, <run id>, <run id>, <run id>; stopped 2026-11-25 to 2026-11-26) stopped "No application form was reached at https://apply.careers.microsoft.com/careers/apply?pid=…: … It may sit behind an Apply button or a step the agent cannot take".
A read-only headless capture on 2026-11-27 (a fresh browser profile, not the agent's own) of one of those addresses showed only Microsoft Careers' sign-in page: "Select a method below to Sign in. This allows you to access your profile or begin a new application." with "Sign in using Microsoft", "Sign in using LinkedIn", "Sign in using Google", "Sign in using Facebook".
Microsoft's position API listed all four positions as open on 2026-11-27.
Cause: a page with no form and no closed notice was always reported as a possibly missed Apply button.
Fix (Track 70): `signInChoicesNotice` (packages/browser/src/site-navigation.ts) reads at least two named sign-in choices, and startBrowserRun (packages/agent/src/browser-orchestrator.ts) names the stop "No application form was reached at <url>: the page shows only sign-in choices (…), and the agent does not sign in or create accounts for you. Sign in at <host> in the agent's browser, then start the run yourself."; the agent still never signs in through a third-party provider.
Regressions: the `signInChoicesNotice` cases in testing-harness/browser-worker/ats-classification.test.ts (`pnpm test:browser-worker:fast`) and the sign-in-choices case in testing-harness/browser-worker/run-lifecycle.integration.test.ts (`pnpm test:browser-worker:local`).
Not verified live: a run on these jobs after the change; the agent's own profile may already be signed in to Microsoft Careers, in which case the form shows and this stop does not apply.

fixture: captured 2026-11-27 (the read-only capture's text; names and host fictional in the tests)

## Refuted causes

- The posting was closed. Evidence: Microsoft Careers' position_details API returned all four positions on 2026-11-27, and the apply page showed no closed notice.
- An Apply button on the page was missed. Evidence: the 2026-11-27 capture's only controls were the sign-in choices, "Sign in", "Sign in here" (employees), and "Join talent network".
