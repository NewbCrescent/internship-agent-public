# Oracle code mail from the company's own domain was ignored

Two Idaho National Laboratory runs on 2026-11-27 (pass 28) stopped with
"Oracle Cloud HCM at <host> emailed you a one-time
code, and none arrived in your mailbox within 3 minutes". A read-only header
listing of the mailbox (sender domain, redacted subject, and date only)
showed the code mails did arrive: from the display name "STAFFING" at the
laboratory's own domain, subject "Confirm your identity", one and zero
seconds after each run's Next click. `relevantOracleCodeHeader` accepted only
Oracle's senders, mail naming the company in full, or the tenant label
(the host's first label) in From, and `messagesSince` applies the same filter before reading
bodies, so both runs polled for 3 minutes and stopped.

Fix (Track 63): `packages/agent/src/oracle-verification-mail.ts` also counts
mail from the company's own domain, derived from the posting, never from the
mail: a sender whose registrable domain name is the company's normalized
name joined (the laboratory's full name without spaces) or the initials of
three or more of its words other than of/and/the/for/at/de
(`companyMailLabels`), or
that sits within the registrable domain of the posting's careers URL
(`companyMailDomains`, skipping application sites and job boards; passed by
the orchestrator's start, continue, and submit). A single word of the name
never counts, other sites' mail (Greenhouse, Workday, iCIMS) is still
rejected first, and the 30-second window and the six-digit code shape are
unchanged. No mailbox change was needed.

Regressions: `pnpm test:agent:oracle-code` (initials, joined name,
look-alike and suffix-attacker domains, single words, careers URL roots) and
`pnpm test:browser-worker:oracle` (a code from the careers domain entered in
a start run); both fail on the old code.

fixture: captured 2026-11-27 (sender domain and subject shape from a read-only header listing; tests use fictional domains)

Boundary: the laboratory's mail body was never read, so the code's wording
in it is assumed to match the existing anchors (code, PIN, passcode). A live
requeue of the Oracle holds confirms it.

Confirmed live (2026-11-27, Track 75 triage, read-only): after Track 63 merged, job <run id> passed the laboratory's email step on three automatic runs (04:33Z, 05:59Z, 12:28Z) and reached the application's questions, each a second after a "Confirm your identity" mail from the laboratory's domain; the fixed matcher over the mail received within a minute of each of the five Next clicks (01:23Z, 01:27Z, and those three) found exactly one code each, so the code's wording matches the existing anchors.
The two jobs this bug was found on (<run id>, <run id>) still hold the pass-28 job-level stop, which pipeline:retry --held does not release; they need pipeline:retry --job … --verified-hold.

## Refuted causes

- The code mail never arrived. Evidence: the header listing of 2026-11-27 shows the laboratory's "Confirm your identity" mails at 01:23:09Z and 01:27:03Z, seconds after each run's Next.
- Oracle did not send a code to a new candidate. Evidence: same listing; only the first INL run (01:18Z) went straight to the form.
