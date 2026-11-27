# Workday postings with a saved draft show Continue Application and were reported as no application

Found 2026-11-27 in Track 70's triage of the "No Workday application opened at <site>" blocker (b03bc425248).
Granite Dynamics (employer-d.wd5, <run id>, stopped 2026-11-26 15:25 UTC) and Rockwell Automation (rockwellautomation.wd1, <run id>, stopped 2026-11-26 23:36 UTC) stopped "No Workday application opened at <url>: Workday showed neither the application nor its closed-posting page."
Their workday-entry captures (2026-11-26T15-25-37-512Z-workday-entry, 2026-11-26T23-36-02-571Z-workday-entry) show the open job page, signed in, with "Continue Application" in Apply's place; earlier automatic runs had saved steps and were then cancelled and requeued.
Cause: `enterApplication` waited only for Apply (`adventureButton`).
Fix (Track 70): it also clicks a visible button or link whose accessible name is exactly "Continue Application" (getByRole, packages/browser/src/ats/workday.ts enterApplication) when Apply is not shown, then waits as after Apply.
Regression: the `continue` mode of testing-harness/browser/fixtures/workday-entry.html in testing-harness/browser/fixture-run.ts (`xvfb-run -a pnpm test:browser:fixture`) (the check also requires the draft to open at its saved step 3).
Not verified: the control's markup and what Workday opens after it (the flow at the saved step, or the Apply chooser; both are handled); this stays open until a live run on one of these jobs opens the application, then `git mv` to bugs/resolved/.

fixture: modelled (from the captures' screenshot and visible text; the control's markup was not captured)

## Refuted causes

- Granite's and Rockwell's postings were closed. Evidence: workday-entry captures 2026-11-26T15-25-37-512Z and 2026-11-26T23-36-02-571Z show the open job page, and Rockwell's says "End Date: November 30, 2026 (3 days left to apply)".
- A Workday security check blocked the entry. Evidence: the same captures show the job page with no cloudflare_error page and no challenge.
- The Workday session was signed out. Evidence: both captures' headers show the signed-in account menu and Candidate Home, and the jobs' events log "signed in with the saved account" on the earlier passes.
