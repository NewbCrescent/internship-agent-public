# One-option acknowledgment lists were held although the standing settings cover them

After pass 31 (2026-11-27) several held runs waited on acknowledgment lists
with only one option, although both standing settings
(`INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT=1`, `INTERNSHIP_AGENT_SIGN_ATTESTATIONS=1`)
are on: Illumio on Ashby (paused <run id>; cancelled <run id> and <run id>),
"Arbitration Acknowledgment:" and "GDPR Acknowledgement" radios whose only
option is "I Acknowledge/Accept this Statement"; Esri on Greenhouse (paused
<run id>; cancelled <run id> and <run id>), "By selecting yes to this
question you confirm that you have read Esri's Applicant Privacy Notice."
with the one option "Yes"; Airbnb (<run id>), "Airbnb Candidate Privacy
Policy" whose only option acknowledges reading it; and Deeplocal (<run id>),
"Privacy Notice" whose only option is "I have read the Privacy Notice.".

Cause: `standingFieldDecision` (`packages/browser/src/standing-fields.ts`)
decided a list or radio set only when it had at least two options, and the
headings alone classify as nothing ("Acknowledgment" is not the verb
"acknowledge", and "I Acknowledge/Accept this Statement" was no headed
agreement).

Fix (Track 67): `singleOptionStatement` (`packages/domain/src/standing-consent.ts`)
reads a list with one affirmative option ("Yes", "I agree", "I acknowledge…",
"I have read…") as its label and that option together ("<label>: <option>",
or "<label> — <option>" after end punctuation), and `HEADED_AGREEMENT` takes
"acknowledge", "/", and a trailing "this statement". The planner decides
such a list on that combined statement under the usual veto order (a
clipped label, a fact, or marketing is never accepted), chooses the option,
and logs the combined text on the timeline ("Accepted attestation: '…'" or
"Accepted data consent: '…'").

Not changed: Airbnb's "Candidate AI Usage Attestation:" ("I agree", a
statement about how the candidate prepared the application, which no
standing group covers), Lockheed Martin's "Confirming my response to the US
Persons question is correct." (a U.S.-person fact), and Veeva Systems'
"I understand that next steps will be sent via email and I have marked the
sender address above as safe." (it states an action the candidate took, a
statement of fact left to the candidate).
The stop re-check (`questions:recheck`) does not count standing decisions,
so the held runs take the rule when they are continued (continue plans open
pauses again with the standing settings) or retried.

Regressions: `pnpm test:domain` (testing-harness/domain/standing-consent.test.ts,
"one-option lists (Track 67)"), `pnpm test:browser-worker:fast`
(testing-harness/browser-worker/standing-consent.test.ts, "one-option
acknowledgment lists in the planner (Track 67)"), and
`pnpm test:browser-worker:local` (self-identification.integration.test.ts,
a held one-option arbitration list continued under both settings, logged
once); each fails on the old code. The tests use fictional names.

fixture: captured 2026-11-27 (the stored labels and options of the held runs, and Illumio's statement text from run trace <run id>, read read-only; the tests use fictional names)

## Refuted causes

- The standing settings were off for the real profile. Evidence: the real .env sets INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT=1 and INTERNSHIP_AGENT_SIGN_ATTESTATIONS=1 (names and values read 2026-11-27), and the decision code skipped lists with fewer than two options (packages/browser/src/standing-fields.ts at <run id>).
- The arbitration statement asserts a fact about the candidate. Evidence: run trace <run id> holds its text, a binding-arbitration agreement with no statement about the candidate.
