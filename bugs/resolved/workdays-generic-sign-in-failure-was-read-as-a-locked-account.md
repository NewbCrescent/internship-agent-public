# Workday's generic sign-in failure was read as a locked account

Found 2026-11-25 (UTC) on the real workspace. In the pass from about 02:03
to 02:41Z, the first account sign-ins that reached Workday after the
one-second wait held 11 hosts as `locked` on their first attempt:
rockwellautomation.wd1, saabusa.wd1, sierraspace.wd1, highmarkhealth.wd1,
employer-h.wd501, micron.wd1, globalhr.wd5, cadence.wd1, littelfuse.wd1,
neogen.wd5 and employer-i.wd1, all with accounts the agent had saved as `pending`.
Each showed Workday's generic message "You may have entered the wrong email
address or password or your account might be locked." Cause:
`classifyWorkdayAccountMessage` tested its lockout pattern
(`\block(ed|out)\b`) before the wrong-credentials one, so the hedged "might
be locked" won. Even read correctly, a refused sign-in with a pending
password held as `interrupted`, although the earlier create submit had
most likely been dropped by Workday's 500 ms check and never made the
account (tmobile.wd1, whose account exists unverified, answered "Verify
your account before you sign in" in the same pass). The classifier now
drops a sentence that hedges a lock (may, might or could be locked,
disabled or suspended) while naming wrong credentials before it looks for
a lockout, so only unambiguous text ("Your account has been locked", "too
many failed sign-in attempts", "temporarily disabled") is a lockout. On an
automatic run, a refused sign-in with a pending saved password submits the
create form once with that password, and the agent does not sign in again
in that call: signed in goes on, a created or verified account waits for a
later pass, and "already exists" holds. `pnpm workday:account --site <host>
--clear-hold` clears one host's hold. Regressions: the classifier cases in
`testing-harness/browser-worker/workday.test.ts` (`pnpm
test:browser-worker:fast`) and the pending-generic, pending-locked,
created-generic, pending-generic-exists, pending-generic-later and
pending-generic-verify scenarios in
`testing-harness/browser/workday-account-run.ts` (`pnpm
test:browser:workday-account`), against the fixture's `signin-error`
modes; the old code held five of them as locked. The 11 false holds are
released by hand; the live proof is the next pass on those hosts.
