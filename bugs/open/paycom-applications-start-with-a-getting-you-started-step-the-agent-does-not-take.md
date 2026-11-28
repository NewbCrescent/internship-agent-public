# Paycom applications start with a Getting You Started step the agent does not take

Found 2026-11-27 in Track 77's triage of the "The application site type was not recognized automatically" blocker (b096af2a79d).
Roto's posting (Creative Developer Intern) is on Paycom (`paycomonline.net/v4/ats/web.php/portal/<portal>/jobs/141319`); run <run id> paused at 2026-11-27 12:52 UTC as an unrecognized site needing input.
Its stop evidence (`applications/d9575d3e-a0d1-45bd-98b7-13511b62d38e/stop-evidence/2026-11-27T12-52-55-140Z-0c77fbff-79e2-490d-813d-d971cac258d1-unanswerable-question/`, real workspace) shows that Paycom's Apply opens a "Getting You Started" dialog: Legal First Name, Legal Last Name, Email Address, Confirm Email, a "Continue To Application" button, and Sign In / Create Account.
Continuing sends the name and email to Paycom before the application itself appears, and a run left awaiting approval on that dialog would click the posting's Apply behind it at submit time.
Change so far (Track 77): `siteWallReason` (`packages/browser/src/site-navigation.ts`) names the step on `paycomonline.net` and `paycomonline.com` (a Confirm Email field and no upload) before anything is typed: "Paycom asks for your name and email at <host> ("Getting You Started") before its application, and the agent has no Paycom adapter yet. Apply in your own browser."
Regression: the Paycom cases in `testing-harness/browser-worker/ats-classification.test.ts` (`pnpm test:browser-worker:fast`).
Next step: a Paycom adapter needs a capture of the pages after "Continue To Application", which sends the candidate's name and email (a form submit outside Track 77's read-only clearance; the manager decides).
fixture: captured 2026-11-27 (the stop evidence's text and region; the wall's cases use its four labels)
