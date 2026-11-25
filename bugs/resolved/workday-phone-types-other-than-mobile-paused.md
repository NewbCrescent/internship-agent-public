# Workday phone types other than "Mobile" paused

Found 2026-11-25 on the real workspace, in manual pass 5. "Phone Device
Type" paused on xboxgaming.wd1 (<run id>), micron.wd1 (<run id>),
rockwellautomation.wd1 (<run id>, <run id>) and highmarkhealth.wd1
(<run id>): the profile's phone type "Mobile" was "not one of its
options", which were "Home Mobile", "Personal Mobile", "Personal Mobile
Phone" and "Mobile - Personal". Cause: the planner chose a phone type only
when an option equalled the profile's value. A saved "Mobile" (or "Cell")
phone type now picks the one option naming a mobile or cell phone that is
not a work, business, corporate, office or company phone; a work or
corporate mobile is never picked, and two personal mobile options, or a
saved "Home" or "Work" type with no equal option, still pause. Regression:
the phone-type cases in
`testing-harness/browser-worker/recognition-planner.test.ts` (`pnpm
test:browser-worker:fast`) and the `?gaps=1` scenario of
`testing-harness/browser/fixture-run.ts` (`xvfb-run -a pnpm
test:browser:fixture`). Not verified live: the tenants' list markup.
