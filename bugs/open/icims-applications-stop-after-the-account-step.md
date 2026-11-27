# iCIMS applications stop after the account step

With `INTERNSHIP_AGENT_ICIMS_ACCOUNTS=1` an automatic run creates or signs in
to the candidate's iCIMS account (2026-11-20), but the agent does not walk
iCIMS's multi-page application (Candidate Profile, Questions, Submit): no
structure past the email-first step has been captured, since the read-only
captures stopped there, and a guessed multi-page walker could click the wrong
control. The run stops once the application shows ("… but it does not fill
iCIMS's multi-page application yet …"), saves no run, and saves
`icims-application` evidence for the job (screenshot and redacted text,
`pnpm run:evidence --job <ref>`). Next step: an iCIMS adapter built from that
evidence, after which iCIMS could leave the approval-needed kinds.

Track 69 triage (2026-11-27): no `icims-application` evidence exists on the real workspace; every iCIMS host reached after the content-frame fix (nine hosts since 2026-11-24) showed an hCaptcha challenge at or after the email step, which the agent never solves, and hq-lifeway holds on a bare "I accept", so no run has reached the application and no walker can be built from evidence yet.
The blank Garmin login pages (about 07:35 UTC daily, 2026-11-25 to 2026-11-27) are not fixed here: the time pattern points to the site, not to reading too early, and no capture shows the frame drawing later.
