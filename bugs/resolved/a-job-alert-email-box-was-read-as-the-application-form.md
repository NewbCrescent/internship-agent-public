# A job-alert email box was read as the application form

Found in pass 16 (2026-11-25) on MITRE's Phenom posting page (run <run id>,
careers.mitre.org): the only field read was `notifiedEmail`, "Please enter
your email address", the page's "get notified of similar jobs" box. It counted
as an email field, so the navigation walk stopped at the posting as the form
and the planner paused on the box instead of following the Apply entry. Fix:
a text or email box whose id names notify, job alert, alert email, subscribe,
newsletter, or talent community is never an application field
(`isSignupField`): `hasApplicationFields` ignores it, so the walk goes on to
the Apply entry, and the planner leaves it empty. Regressions: `pnpm
test:browser:unrecognized-forms` (fixtures/job-alert-posting.html) and the
Track 35 cases in `pnpm test:browser-worker:fast`.
