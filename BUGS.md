# Bugs and Product Gaps

Confirmed defects belong here. Do not convert roadmap items or unverified suspicions into bugs.

## Open

### Re-qualification can silently regress terminal application statuses

`evaluateAndPersistMatch` derives the posting status from the fresh verdict
without consulting the current status or writing an `application_events` row.
On 2026-10-07 a bulk re-qualification moved a Sep 23 AI-submitted posting
(`<run id>`, submitted with confirmation) back to `ANALYZING` with no event,
and a later prepare pass returned it to `READY_FOR_REVIEW`; the status was
restored to `SUBMITTED` with an explanatory event, and the one-off rematch
script now skips `SUBMITTED`/`APPROVED`/`APPLYING`. The orchestrator itself
still has no guard, so any future broad re-match can repeat the regression.
Fix direction: refuse to move terminal or in-flight statuses backwards (or at
least record the transition as an event).

### Change-aware verification skips the job extraction suites

`testing-harness/support/agent-workflow.mjs` maps `packages/jobs/` only to the
`foundation` feature, so `pnpm agent:verify` after an extractor change does not
select `job-normalization-contracts` or `discovery-contracts` (both `jobs`).
On 2026-10-13 a change to `packages/jobs` passed `agent:verify` while
`pnpm agent:finish jobs` failed on an outdated `parseJobListOptions`
expectation. Fix direction: map `packages/jobs/` to `jobs` and `ingestion`.

### The displayed fit silently falls back to the keyword estimate

`getMatchReport` (`packages/agent/src/match-orchestrator.ts`) returns the
keyword estimate as `displayFitScore` whenever the AI assessment is missing or
stale, with no marker in the number itself. On 2026-11-17, 214 of the 404
prepared postings shown at 80+ were keyword estimates (their AI scores predated
the current profile context version 5); the estimate gave 100 to a French
"Product Data Analyst F/M" (AI 52) and a Geneva ML role (AI 62). The automatic
pipeline's target never reads `displayFitScore` (it uses only a current AI
judgment), but `INTERNSHIP_AGENT_PREPARE_MIN_FIT` and the Jobs ordering still
do. Fix direction: carry the score's source with it and never compare a keyword
estimate against an AI threshold.

### The verb "master" is read as a degree requirement

The deterministic extractor labels "Master's the team's business domain basics
within 1 month" (Example Analytics, 2026-11-17) as a `DEGREE` requirement.
It stays PREFERRED and the graduate-only exclusion ignores it, but it adds a
spurious degree line to the match report. Fix direction: require degree or
program wording near "master's" before assigning `DEGREE`.

### The model-throughput suite cannot resolve zod on a fresh install

`testing-harness/jobs/model-throughput.test.ts` imports `zod` directly, but
neither the root `package.json` nor `packages/jobs` declares it, so after a
fresh `pnpm install --frozen-lockfile` (PC, 2026-11-17) the file fails to load
and takes `test:jobs:fast` (job-normalization-contracts and
discovery-contracts) down with it; the other four files in that script pass.
Fix direction: declare `zod` where the test resolves it, or import the schema
helpers through a workspace package.

### iCIMS applications stop after the account step

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

### Oracle Candidate Experience's several-section form and post-submit code are not handled

The agent now takes Oracle Cloud HCM Candidate Experience's email step and its
emailed one-time code (see Resolved), but what follows is not handled yet, so
`oracle` stays in `ATS_KINDS_NEEDING_APPROVAL`. No adapter walks Oracle's
several-section form (`/apply/section/<n>`, Next per section, Submit only on
the last): a single-section form is filled by the generic filler, and a
section showing Next stops the run with the several-page reason. A new
candidate meets Oracle's code step only after Submit (`/apply/confirm`), and
the post-submit security-code lookup reads only Greenhouse's mail and its
hold texts say Greenhouse; a successful submit lands on `/my-profile`, which
is not read as a confirmation. Oracle's field ids carry counters
(`primary-email-0`, `-1`), so a continue or submit may not find the saved
fields and fail closed. The PIN, section, and confirmation screens and their
English strings, and the code email itself, were never seen (derived from
Oracle's public Candidate Experience bundle). Next step: a capture of a
section page from a session the candidate opens, then a section walker and
the post-submit code step and confirmation (after Track 10's submit-outcome
work merges), each with a disposable-Chromium regression.

### SmartRecruiters application pages show DataDome to the agent's browser

A SmartRecruiters posting's "I'm interested" leads to
`/oneclick-ui/company/<company>/publication/<id>`, which showed a DataDome
CAPTCHA page to a fresh, headful capture browser on 2026-11-24, as it did to
the headless one on 2026-11-19. The agent never solves it: an automatic run
stops with "The application page at jobs.smartrecruiters.com showed a
DataDome CAPTCHA page; the agent never solves CAPTCHAs, so start this
application yourself.", and a candidate-started run is held on the
challenge. The form behind it could not be read, so no adapter fills it, and
`smartrecruiters` stays in `ATS_KINDS_NEEDING_APPROVAL` (its own success text
"Application submitted!" was found in the page's translation bundle, but
the form walk and its regression are missing). Next step: a read-only capture
of the application form from a session the candidate opens.

### Paylocity applications span five steps

A Paylocity Recruiting application (`recruiting.paylocity.com/Recruiting/Jobs/Apply/<id>`,
captured read-only on 2026-11-24) is a form of five steps: the first page
shows "Step 1 of 5", the identity, address, and LinkedIn questions, and a
"Next Step" button, and no submit control. The agent now recognizes the kind
(`paylocity`), reaches that page from the posting (closing the accept-only
cookie banner), and stops the run there with the several-page reason before
anything is typed, since filling only the first page would leave the run
stuck at submit. No success text was found in the site's own scripts. Next
step: a capture of the later steps (questions, EEO, review, submit, and the
confirmation) from a session the candidate opens, then a Paylocity walker
with a disposable-Chromium regression; until then `paylocity` stays in
`ATS_KINDS_NEEDING_APPROVAL`.

## Resolved

### Workday ignored an account submit made within 500 ms of the form appearing

From 2026-11-20 to 2026-11-24 the account submit got no answer at employer-f.wd1,
employer-h.wd501, tmobile.wd1, saabusa.wd1, neogen.wd5 and littelfuse.wd1;
where the diagnostics were recorded they read "no same-host request
observed; no page transition observed". A cookie banner was on some of these
sites and not on others. Cause: Workday's sign-in widget
(candidate-experience-apply-flow 2026.47.19, read 2026-11-24) installs three
"NoCaptcha" tests when an account submit button mounts: a 500 ms timer, the
empty `beecatcher` honeypot, and a click on the click filter over that
button. Its form `onSubmit` calls `preventDefault()` with no message while
one of them has not passed. Against the synthetic fixture, `signInToWorkday`
clicked the sign-in filter 62–82 ms after the sign-in submit button appeared
(after the Sign In link or the email chooser), and `createWorkdayAccount`
116–598 ms after the create button, so the timer test fails silently.
On 2026-11-24 the candidate chose ("yes a second") to let Workday account
submits wait about one second after the form appears, so this minimum-time
check passes; AGENTS.md's site-safeguard invariant records it as the only
such allowance. `signInToWorkday` and `createWorkdayAccount` now note when
they first see the form (its submit button, or the click filter over it,
visible) and click no sooner than 1,000 ms after that moment, so typing time
counts and a slow page does not wait twice. It is still one plain click, the
honeypot is never typed in, and a visible challenge still holds the host.
Regression: the dwell scenario in
`testing-harness/browser/workday-account-run.ts` (`pnpm
test:browser:workday-account`), against the fixture's `?dwell=1` mode, which
drops without a message a submit clicked under 500 ms after its button
mounted; there the old code dropped both the create submit and the sign-in
submit after it. The live proof is still a real sign-in.

### Ashby's text-message consent radios were labelled by their name

The 2026-11-24 runs of two Illumio postings (Ashby) paused on a radio set whose
only label was `communicationConsent`, its name attribute. Ashby draws its
text-message consent inside the phone field's entry, in
`.ashby-application-form-texting-consent-description`, with no fieldset,
legend, or label for the question, and the nearby-question walk stopped at the
phone input; the radios also took the phone's required mark. No code applied
the candidate's text rule either: the standing settings count every text
opt-in as marketing. Now the radios take the consent text ("Check Yes or No to
indicate your agreement to receive text message updates from … regarding your
job application …"), a fieldset checkbox group with no legend takes its
question title, and the candidate's rule (2026-11-20, "Texts yes about my
application status") answers texts about this application Yes and marketing or
job-alert texts No, and pauses a mixed or unclear question with its label
(`textMessageTopic`, `textMessageConsentDecision`). Regressions: the Ashby
texting-consent scenario of `pnpm test:browser:greenhouse`
(`fixtures/ashby-texting-consent.html`) and the text-message cases of
`pnpm test:domain` and `pnpm test:browser-worker:fast`. The paused runs keep
their stored pause; a fresh run applies the rule.

This closes the open entries "Ashby's text-message consent is read without
its question" and "Application-status text consent is not implemented"
(2026-11-24). As that second entry noted, the rule is not one of the two
standing settings in AGENTS.md: it is the candidate's own rule, applied in
code like the how-did-you-hear rule, and it never accepts marketing.

### Runs that never reached an application form waited at the submit step

On 2026-11-24 three automatic runs, on an Oracle Cloud HCM posting, a
SmartRecruiters posting, and a Paylocity posting, reached `awaiting-approval`
with only skip decisions: the controls read there were an Oracle share
widget's copy-link box, a SmartRecruiters share dialog's box with neither id
nor name, and a OneTrust cookie preference panel's toggles and vendor search.
Cause: `startBrowserRun` treated any control of a known kind as a form, so the
posting's Apply entry was never followed and the automatic no-form stop never
fired; the planner skipped every control, and a run with nothing filled and
no pause was saved as waiting at the submit step. `continueBrowserRun` saved
the same shape, and `submitBrowserRun` reopened the address and clicked
submit even when none of the approved fields was on the page. Fix: a run
whose decisions fill, choose, check, upload, keep, or pause nothing stops
with "No application form was reached at <url>: …" (automatic runs as a
recorded stop), saving nothing and leaving the job status unchanged; a
continue that fills nothing and has nothing left to ask keeps the run paused;
a submit whose page shows none of the approved fields clicks nothing and
keeps the approval. Cookie-consent managers' controls, share and copy-link
boxes, and honeypot text boxes are no longer read as fields
(`collectControlsIn`), so the Apply entry and the new site navigation are
tried on such pages. Regressions: "runs that never reached an application
form" in `testing-harness/browser-worker/run-lifecycle.integration.test.ts`
(`pnpm test:browser-worker:local`) and the consent scenarios in
`testing-harness/browser/site-navigation-run.ts`
(`pnpm test:browser:site-navigation`). Runs already saved in that state are
not changed.

### Package answers filled questions they do not answer

Track 10's review of the two SemiAnalysis Dover runs (job <run id>, "Summer
Intern - AI Tokenomics", and job <run id>, "Semiconductor & AI Research
Intern") found required free-text questions filled with the package's generic
"Why are you interested in this role?" answer ("I am applying for the <title>
role at <company>. …"), one of them a technical question about CPX vs NVL72
prefill. Cause: `matchPackageAnswer` in
`packages/browser/src/autofill-planner.ts` matched on single word stems (why,
interest, motivat, company; experience, background, relevant, project,
qualification; authoriz, sponsor, start, availab, eligible, work in), so any
text question containing one of them received a canned answer. Fixed
2026-11-24: a package answer fills a text box only when the whole label
(without its required marker, "(optional)", a trailing length hint, and end
punctuation) is one of a fixed set of phrasings of the same question (why are
you interested in this role or company, describe your relevant experience, a
work-authorization or availability summary); a technical "why" question,
"Which company…", "Describe a project where…", "How many years of
experience…", "Explain why…", and every other label follow the usual rules
(question memory, a voice draft, an optional skip, or a pause). The package
contents are unchanged. Regressions: "gives a package answer only to a question
that asks the same thing" in
`testing-harness/browser-worker/recognition-planner.test.ts`
(`pnpm test:browser-worker:fast`). Runs already saved with such fills are not
changed.

### A Workday step was saved after reading no fields

Two Workday runs (2026-11-20 and 2026-11-24) planned nothing on My
Information and clicked Save and Continue, so Workday reported the name,
phone, and how-heard fields empty, though the profile and the how-heard rule
answer all of them. The readiness wait counted field containers the step
reader then skipped as not visible, and the walker saved a step from which it
had read no field. The wait now counts only visible field containers, and a
step read with no fields is read once more and never saved past (the walk
stops as blocked, "could not read any field"). The cause (a step drawn
hidden while loading) is inferred from the recorded runs and has not been
confirmed on a live page. Regressions: the two no-field Workday tests in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts`
(`pnpm test:browser-worker:local`) and the synthetic `?hidden=` Workday
fixture in `testing-harness/browser/fixture-run.ts`
(`pnpm test:browser:fixture`).

### Continued runs kept stale pauses and could not keep Greenhouse multi-select choices

Found 2026-11-24 from the recorded evidence of a real Greenhouse run.
Continuing a held run never planned its open pauses again: a pause built by
older code (package prose offered to a racial/ethnic "mark all that apply"
list, not marked sensitive) stayed as it was, and a standing setting or a
saved self-identification answer added since never answered its pause. A
pause candidate memory now answered got a fill decision but stayed open, so
the run stayed held and the pause was still listed. A react-select
multi-select ("mark all that apply") shows the choice as a chip, not a single
value, so the fill was reported as "the page did not accept the value"; and
the pause that replaced a failed demographic fill lost its sensitive flag.
Continue now plans every open, unanswered pause with today's rules and marks
a pause memory or a rule answers as answered (without copying a protected
option), the chip counts as the kept choice, and a failed demographic fill
stays sensitive. The multi-select markup is react-select's standard isMulti
markup, assumed for Greenhouse and not captured. Regressions: the "continuing
a held run" tests in
`testing-harness/browser-worker/self-identification.integration.test.ts`
(`pnpm test:browser-worker:local`), the unfilled-pause test in
`testing-harness/browser-worker/consent-and-facts.test.ts`
(`pnpm test:browser-worker:fast`), and
`testing-harness/browser/greenhouse-demographics-run.ts`
(`pnpm test:browser:greenhouse-demographics`).

### Saving any candidate fact made every AI fit stale

Found 2026-11-25 on the real workspace. Loading facts with `pnpm
profile:facts --set-file` and saving one answer with `pnpm run:answer`
raised the AI-fit context version from 57 to 64, so all 228 cached fits went
stale and the next pass held every posting with "Fit: no current AI
judgment." until it was re-scored, at most 25 per pass. Cause: the
`candidate_facts` triggers (migration 0024, rebuilt by 0030) bumped the
context version on every fact write, but the fit prompt reads only one
fact, `graduation_date` (the expected graduation in its level context);
legal, sensitive, and application-only answers never reach it. Migration
0034 recreates the three triggers so they fire only for the keys in
`FIT_CONTEXT_FACT_KEYS` (packages/domain `matching.ts`), which the fit
builder's key type is limited to; it does not bump the version itself, so
fits scored before it stay current. Regressions:
`testing-harness/db/fit-context-facts.test.ts` (`pnpm test:db`) and the
fact-key and fact-staleness tests in
`testing-harness/matching/semantic-fit.integration.test.ts` (`pnpm
test:matching:local`).

### Known answers went unused on common application questions

Recorded runs paused on questions the agent could already answer: "legally
eligible to work in the country you are applying for" was not read as work
authorization; Greenhouse's "How would you describe your gender identity /
racial/ethnic background? (mark all that apply)" lists were vetoed as open
prompts and the race list was not even marked sensitive; "Which college did
you attend?" and options carrying a US state code ("…(CA)") did not match the
profile school, and the "If you selected other, please specify" box after it
paused; "What degree level are you currently pursuing…" was not read as the
degree; a graduation year list was compared with the full graduation date;
"Please provide a link to your LinkedIn profile." did not match the LinkedIn
label; a required marketing Yes/No list paused although marketing is always
declined; "Are you a current college student majoring in computer science or
related field?" had no rule; and package answers were offered to choice
fields (a pause echoing the package text, or an optional choice paused instead
of skipped) and to background-check questions. Each now has a deterministic
rule (this also resolves the "Package answers fill select and radio fields"
entry below). Regressions:
`testing-harness/agent/question-mapper.test.ts` (`pnpm test:agent`),
`testing-harness/browser-worker/self-identification.test.ts`,
`ats-classification.test.ts`, and `recognition-planner.test.ts`
(`pnpm test:browser-worker:fast`), and
`self-identification.integration.test.ts` (`pnpm test:browser-worker:local`).

### Package answers fill select and radio fields and pre-empt question memory

`matchPackageAnswer` in `packages/browser/src/autofill-planner.ts` fills any
field whose label matches its word stems (why, interest, motivat, company;
experience, background, relevant, project, qualification; authoriz, sponsor,
start, availab, eligible, work in) with the package's prose, whatever the
field kind, so a select or radio such as "Do you have experience with
Python?" gets a fill decision carrying the relevant-experience paragraph
instead of an option, and a generic question like it never pauses, so the
candidate's answer is never asked for or saved to question memory. Found
2026-11-19 while building question memory (run H); the question-answers
integration fixtures avoid the word "experience" for that reason (the
`PYTHON_LABEL` comment). Fix direction: offer package answers only to text
and textarea fields, so such questions reach question memory or pause.

Fixed 2026-11-24: package answers are offered only to text boxes and text
areas, so a select or radio set such as "Do you have experience with Python?"
follows the usual rules (a remembered answer, a shown value, an optional skip,
or a plain pause whose answer can be remembered). Regressions: the
package-answer cases in
`testing-harness/browser-worker/recognition-planner.test.ts`
(`pnpm test:browser-worker:fast`).

### iCIMS account steps inside the career site's frame were never read

The 2026-11-21 retry pass stopped six iCIMS runs (General Dynamics Mission
Systems, IDEMIA, BISSELL, Example Consultants, Mapwise Technologies; Garmin as
evidence only) with "the account step stopped (a page the agent does not
recognize)". The `icims-account` evidence showed the email step in the
screenshot while the top document's text held only the career-site wrapper:
iCIMS draws the account screens in a same-host `icims_content_iframe`
(`?in_iframe=1`), and `packages/browser/src/ats/icims-account.ts` inspected
only the top document, so nothing was typed. Now the screens are read and
driven in that frame (never one on another host), and CAPTCHA detection
covers it. Regression: the framed scenarios of
`pnpm test:browser:account-consent`. The hosts' stored `unexpected` holds must
be cleared (`pnpm icims:account --site <host> --clear-hold`) before a pass
retries them; the multi-page application behind the account step is still the
open "iCIMS applications stop after the account step" entry.

### Known site field refusals held continued runs in submission uncertainty

After a candidate answered an invalid field pause and continued a browser run,
the run returned to `awaiting-approval` with approval cleared (`submissionApprovedAt: null`).
However, `explainsPriorSubmit` and `receiptInvestigation` only recognized
`field-errors` and `verification-code`, treating any site refusal captured as
`outcome: "refused"` with `invalidFields` as a conflicting uncertainty capture,
which routed the run to manager-owned `possible-submission` instead of candidate-owned
`approval`. Now `isFieldRefusal` recognizes both `field-errors` and `refused` with
non-empty `invalidFields`, allowing continued runs to proceed to approval while
preserving uncertainty holds for genuine ambiguous submissions without field lists.
Regressions: continued run hold routing tests in
`testing-harness/agent/submit-evidence.integration.test.ts` (`pnpm test:agent:evidence`).


### A new audit finding repeated every previously delivered finding

A watcher held its delivery history in memory, so restarting could send the
same prompt again. When one new finding arrived, the watcher formatted the
entire audit, which repeated all earlier items. Regression: the SQLite-backed
audit fixture delivers the first item, reopens the database, and verifies that
a later injection contains only the new manager item. A failed injection
remains pending, and resolving and reopening an item produces a new revision.

### Radio choice lookup disagreed with the option label read from the form

Starwood's Jobvite work authorization and sponsorship choices reopened with
“the option was not found” after the run tried to apply the answers. The
Jobvite Chromium fixture reproduces that error when a radio's visible label
differs from its accessible name. The browser now selects named radios by the
same labels it reads from their group and refuses duplicate matches. The
fixture verifies both successful selections and the duplicate-label hold.

### Workday's sign-in click filter labelled "Submit" was not clicked

On 2026-11-24 Rockwell Automation (rockwellautomation.wd1) held the host
with "the account step failed in the browser (the Sign In button could not
be clicked)"; KLA (employer-i.wd1) logged the same on 2026-11-20 (not re-checked
live). A read-only live capture of Rockwell's sign-in step (2026-11-24,
disposable profile, nothing typed or submitted) showed the click filter over
`signInSubmitButton` labelled "Submit", not "Sign In"; Workday labels the
filter by its internal auth view, and the create filter there reads "Create
Account". `press` in `packages/browser/src/ats/workday-account.ts` took only a
filter carrying the button's label, so it fell back to the hidden button
under the filter, and the click timed out after 10 seconds. The cookie banner
was not the cause: it sits in normal page flow at the top (position static,
no full-viewport backdrop), and `elementFromPoint` at the button's centre
returned the "Submit" filter. The click now goes first to the one visible
click filter inside the `noCaptchaWrapper` holding the form's own submit
button, whatever its label; the label rules remain as fallbacks. Rockwell's
sign-in then meets the 500 ms gate above. Regression: the submit-label
scenario in `testing-harness/browser/workday-account-run.ts` (`pnpm
test:browser:workday-account`).

### Workday's sign-in after account creation got no answer

On 2026-11-20 (about 20:51Z) Camping World (employer-g.wd5) logged
"account created with your email; the password is saved locally" and then
held the host with "the account step stopped (Workday did not answer the
sign-in submit within 20 seconds)"; Example Brands (examplebrands.wd5) did
the same. The evidence screenshot shows the Sign In form filled, no error.
`press` in `packages/browser/src/ats/workday-account.ts` clicked the first
visible click filter labelled "Sign In" anywhere on the page. The cause is not
confirmed: a read-only capture of employer-g.wd5's public `/login` page
(2026-11-20) shows only the form's own visible "Sign In" filter, beside
`signInSubmitButton` in `noCaptchaWrapper` (the header's "Sign In" there is a
hidden `auth_signin_link`), so the click may have landed correctly and
Workday may ignore sign-ins until the email is verified. Both hypotheses are
now covered. The click goes to the filter beside the form's own submit
button (else a labelled filter inside the sign-in content or a dialog, never
page-wide). A not-verified message ("Your account has not been verified",
"verify your email") is the verification step even when it mentions the
password, and so is such a notice drawn as plain text while the form stays
up. A sign-in that gets no answer right after this run created the account
goes to the Gmail verification flow ("Workday did not answer the sign-in
after the account was created; the agent looks for the verification
email."), which holds as `verify-email` (retried after an hour) when no
email arrives. The live proof is a re-run on those hosts. Regressions: the
decoy (synthetic header filter), notice, and quiet scenarios in
`testing-harness/browser/workday-account-run.ts` (`pnpm
test:browser:workday-account`) and the not-verified cases in
`testing-harness/browser-worker/workday.test.ts` (`pnpm
test:browser-worker:fast`).

### Rippling application pages were not recognized

On 2026-11-20 Bound (ats.rippling.com) was held with "The application site
type was not recognized automatically" although every field was filled.
Rippling is now kind `rippling` (`ats.rippling.com` URLs), recognized for
display and in `ATS_KINDS_NEEDING_APPROVAL`, so the candidate approves each
run: a read-only capture (2026-11-20) shows its form at `<posting>/apply`
behind an "Apply now" button, a progress bar on that page, and no success
text in the page's own bundles (only a translation key, `successfullyApplied`),
so a submitted run could not be told from a stalled one and no confirmation
phrase was added. No Rippling fixture was built (the capture allowance for
Rippling pages is used up). Bound's run now shows "Rippling application sites
are recognized, but the agent has no adapter that walks their application, so
you approve each one." instead of "not recognized". Still open: on the static
capture Rippling's uploads, inside `label[aria-labelledby]`, read as
unlabeled (Bound's live run filled every field). Regressions: the Rippling cases in
`testing-harness/browser-worker/ats-classification.test.ts` (`pnpm
test:browser-worker:fast`).

### Dover application forms were not read or recognized

On 2026-11-20 Mindsmith, Headstarter, Deccan AI, and Revealed (all
app.dover.io application pages) paused with labels that were a zero-width
space (U+200B) and one UUID. Read-only captures of two Dover pages
(2026-11-20) showed the causes. Each input sits in an MUI outlined box whose
notched-outline legend holds only U+200B, and that legend won the label
search because whitespace collapsing does not remove zero-width characters.
The visible question ("First Name *", "Resume *", "What is your Visa Status?
*") is a sibling `div` with class `styles__FormLabel-…` (capital L), which
the in-page collector's `[class*="label"]` did not match, so fields read as
their names ("firstName") or as UUIDs. The relocation radio took its first
option's own label ("Yes"), and both uploads read "Yes" because the upload
label walk in `fileLabel` climbed past other questions to a radio option.
An "Autofill from resume" drop zone before the form read as a question. And
app.dover.io redirects to `jobs.dover.com/job/<id>`, which nothing classified,
so the kind was unknown.

Now every label source in `collectControlsIn`
(`packages/browser/src/handshake-executor.ts`) and `recognizeFields`
(`packages/browser/src/form-recognition.ts`) drops invisible characters
(`INVISIBLE_CHARACTERS`), a bare UUID counts as empty, a name holding a UUID
never labels a control, and an option made only of invisible characters is
dropped. The question text near a control also matches a case-sensitive
`[class*="FormLabel"]`. An option's own label (a label holding exactly one
radio or checkbox) and aria-hidden text are never a question's label. An
upload's label walk stops at an ancestor holding another question's control.
A `role="button"` drop zone that says "autofill" is skipped like Ashby's
parser box. The `dover` kind matches `app.dover.io` and `jobs.dover.com` URLs
(and the footer's "By applying you agree to Dover's terms").

Dover proceeds automatically: it is one page with one Apply submit, and its
"Thanks for applying!" is recognized by the existing confirmation pattern.
Its hidden Turnstile token is page machinery; a visible Turnstile widget
still holds the run. A real Dover submit has not been run. Regressions: the
Dover block of `testing-harness/browser/greenhouse-fixture-run.ts` (`pnpm
test:browser:greenhouse`, fixture `dover-application.html`), the Dover cases
in `testing-harness/browser-worker/ats-classification.test.ts` and the
invisible-character case in
`testing-harness/browser-worker/recognition-planner.test.ts` (`pnpm
test:browser-worker:fast`).

### An over-long posting constraint sentence failed the analysis

The retry pass of 2026-11-20 logged "Analysis failed for a6fc73c0-…" (and
b66d8785-…, six in all) with a `too_big` error at
`constraints.authorization.raw`, maximum 600. It was not a model string: the
deterministic extractor (`extractAuthorization` in
`packages/jobs/src/deterministic-extractor.ts`) keeps the whole "sentence"
around "authorized to work", and a sentence with no period or newline can be
longer than the schema's 600 characters; the write path stored it without
validation, so every read of the posting failed. Now a stated constraint
longer than 600 characters keeps a window of at most 600 around its keyword
(the decision still reads the whole sentence, so no eligibility reading
changes), and rows stored before that are clipped on read
(`clipStatedText` in `packages/domain/src/job-posting.ts`, used by
`getJobPosting`). Model-output schemas are unchanged. Regressions: the
over-long sentence case in `testing-harness/jobs/normalization-contracts.test.ts`
and the stored over-long row in
`testing-harness/matching/match-persistence.integration.test.ts` (`pnpm
test:matching:local`).

### Workday's create-account recovery missed the email sign-in chooser

Raytheon's saved page showed the email sign-in chooser after a create timeout.
The adapter supported that chooser on entry but did not handle it when the
create form's Sign In link opened it. The recovery now recognizes the chooser
on the expected Workday host and selects email once. The account service also
preserves the create timeout's request and page transition diagnostics in the
follow-up hold or timeline event. The Chromium fixture covers the chooser
transition and the diagnostics in an interrupted hold. Raytheon's saved
evidence did not include the chooser's DOM marker or establish the cause of
the live create timeout.

### Workday's create-account submit was held after 20 seconds

On 2026-11-20 three automatic runs checked the terms box on Workday's
create-account form, submitted it, and then held the host with "the account
step stopped (Workday did not answer within 20 seconds)": Example
Brands (examplebrands.wd5.myworkdayjobs.com, 08:31Z), Example
Insurance (employer-f.wd1, 10:23Z), and Example Nonprofit (employer-e.wd5,
14:23Z). The password is saved before the submit, so each account may or may
not exist. Cause: `settle` in `packages/browser/src/ats/workday-account.ts`
gave every submit a fixed 20 seconds and turned anything else into a generic
"other" result. Now a create-account submit gets up to 60 seconds (checked
every 500 ms; a sign-in still 20); "already exists", and no answer within
60 seconds, lead to one sign-in with the saved password (signed in goes on,
a verification screen goes to the Gmail flow, a refused sign-in holds as
`exists` or `interrupted`); an error banner holds with Workday's redacted
text; a CAPTCHA holds and is never solved; every hold reason names what
happened (`workday-account-service.ts`).

If both the create-account submit and its one follow-up sign-in time out,
the agent checks the configured mailbox once for a verification message
associated with the pending account. It opens only a unique verification link
whose HTTPS origin exactly matches the career site. Missing, ambiguous,
unreadable, or off-origin mail leaves the account pending with its original
`unexpected` hold. If opening the verification page fails, the hold uses a
generic reason that omits the activation URL and token. A valid link uses the
existing verification and sign-in flow.

These holds are entries in the
accounts file, not saved runs (the account step runs before the walk), so
`pnpm pipeline:retry --held` now releases holds of kind `unexpected`, and
the next pass signs in with the saved password. Regressions: the slow
create, slow verify, double create, silent, lost, and banner scenarios and
the six dual-timeout mailbox cases (valid, missing, ambiguous, unreadable,
off-origin, and navigation failure) in
`testing-harness/browser/workday-account-run.ts` (`pnpm
test:browser:workday-account`), the no-answer and existing-account cases in
`run-lifecycle.integration.test.ts`, and the account-hold cases in
`automatic-retry.integration.test.ts`.

### Workday's page errors were one opaque pause

The Granite Dynamics run (employer-d.wd5.myworkdayjobs.com, 2026-11-20 19:30Z)
created its account, walked, and paused with a single "My Information
(Workday errors)" pause, so the digest showed no real question and Workday's
field errors were not kept. Now `readWorkdayErrors` reads Workday's error
list (`errorMessage`, `inputAlert`, the `errorBanner` items, alerts, with
each inline error's field container and label) and `workdayErrorPauses`
makes one pause per error, "<field label>: <Workday's error text>" on
`<step>::workday-error::<field id>` (or `workday-error-<n>` for an error on
no known field); the banner's repeats add none. An answer fills the field on
the next walk and is never saved to generic question memory. The single
"(Workday errors)" pause remains only when Workday shows no error text. The
Granite errors were never captured, so no recognition or mapping change was
made. Regressions: `workday.test.ts` (`pnpm test:browser-worker:fast`), the
blocked walk in `fixture-run.ts` (`pnpm test:browser:fixture`), the Workday
error case in `run-lifecycle.integration.test.ts`, the Workday case in
`automatic-retry.integration.test.ts`, and `question-answer-memory.test.ts`.

### Workday stops left no evidence

The account-step holds and the Granite pause above kept nothing of what Workday
showed. Now every account-step hold and every step Workday would not save
saves local evidence while the page is open (`saveWorkdayEvidenceQuietly`;
outcomes `workday-account` and `workday-errors`; folder 700, files 600;
screenshot, redacted visible text, query-stripped URL, Workday's errors with
their labels, and the agent's detail). An account-step stop has no run yet,
so its folder is the job's (`<time>-workday-account`, `runId` null) and the
account email and password are replaced by "[redacted]"; `pnpm run:evidence
--job <ref>` shows a job's evidence. Regressions:
`submit-evidence.integration.test.ts` (`pnpm test:agent:evidence`) and the
Workday evidence cases in `run-lifecycle.integration.test.ts`.

### An automatic approval that never reached the site used the day's auto-submit slot

On 2026-11-20 the real workspace's daily cap
(`INTERNSHIP_AGENT_AUTO_SUBMIT_DAILY_CAP=1`) was used by the Tidewave attempt
(10:08Z): it was approved automatically and clicked, but Greenhouse then
asked for an emailed security code, so nothing was submitted, and no real
application could go out that day. The cap counted every "Submission
approved automatically by your auto-submit policy" event since local
midnight. Now `automaticSubmissionsSince` (`pipeline-orchestrator.ts`) ties
each approval to its job's latest run created at or before it and releases
it only when that run is known not to have reached the site: its approval
was withdrawn (field errors after the click, a challenge, a missing security
code: the run is back with the candidate) or the failed submit was reopened
with `--reopen-unsubmitted` before the job's next run began. A submitted,
submitting, failed, cancelled, or still-approved run, or an approval whose
run cannot be found, still counts. Regression: the "daily auto-submit cap"
cases in `automatic-retry.integration.test.ts` (`pnpm test:agent:retry`).

### Greenhouse's security-code email was DMed as a recruiter reply

The Gmail watcher read "Security code for your application to Tidewave" from
us.greenhouse-mail.io (2026-11-20) as a "Recruiter reply": it DMed the
candidate and logged "Email received: Recruiter reply …", which the daily
digest would count as a company reply. Security and verification code emails
are machinery. `mail-outcomes.ts` now files a subject naming a security
code, verification code, one-time code, or "Verify your account" (and a
would-be recruiter reply whose body names such a code) as the `verification`
category: never DMed (`scanUids`, `formatMailNotice`), never counted by the
digest (nor the older "Recruiter reply" note with such a subject), and still
noted as `Email received: Verification code from <domain>: "<subject>"` with
code-like subject tokens replaced by "[code]". The `--reopen-unsubmitted`
evidence check reads the label-agnostic note, so the Tidewave note stored
under the old label still counts. Regressions: `mail-outcomes.test.ts`,
`mail-watch.integration.test.ts`, `daily-digest.integration.test.ts`, and
the security-code note cases in `automatic-retry.integration.test.ts`.

### Greenhouse's emailed security-code step was read as an unconfirmed submit

Tidewave (Greenhouse new board, job <run id>, 2026-11-20 10:08Z) failed as
unconfirmed ("no confirmation text was recognized") after its automatic
submit click. At 10:09:26Z the Gmail watcher logged "Security code for your
application to Tidewave" from us.greenhouse-mail.io, so the site had asked
for an emailed security code after the click and the application was not
completed. The app had no outcome for that step, and `pnpm pipeline:retry`
refused the failed run because its submit was approved. Now the step (new
security-code inputs plus text about a code sent by email) is the
`verification-code` outcome: on a Greenhouse board the code is read from the
candidate's mailbox (read only, every 10 s for up to 3 minutes; a Greenhouse
sender, a subject naming the security code and the company, exactly one
distinct code), typed in, and the step's own submit clicked before the
confirmation wait restarts; otherwise the run is held `paused-needs-input`
with the approval withdrawn ("Greenhouse emailed a security code; it was not
found …"), and a step still shown after entry fails closed. The code is never
logged, stored, or put in an event, notice, error, or evidence (texts are
scrubbed, no screenshot after it was typed).
`pnpm pipeline:retry --run <ref> --reopen-unsubmitted --reason "<text>"`
reopens a failed submit only with evidence the site did not complete it (the
security-code email event after the approval, or verification-code evidence)
and never one with a confirmation. The step's markup and the email's wording
come from third-party descriptions, not a capture. Lumora (Ashby, run
<run id>) is left as is: no public markup knowledge of an Ashby email-code
step was found, and no email arrived. Regressions: the "Greenhouse's emailed
security code" tests in `recognition-planner.test.ts` and
`run-lifecycle.integration.test.ts`, the `--reopen-unsubmitted` cases in
`automatic-retry.integration.test.ts`, the verification-code cases in
`submit-evidence.integration.test.ts`, `greenhouse-security-code.test.ts`
(`pnpm test:agent:security-code`), and the `?code=1` scenarios of
`pnpm test:browser:greenhouse`.

### Unconfirmed submissions left no evidence and Greenhouse's confirmation page was not read

Two automatic submissions on 2026-11-20 ended failed with "The submit button
was clicked and the application dialog closed, but no confirmation text was
recognized": Lumora (Ashby, run <run id>, about 05:30Z, before run N added
Ashby's success container) and Tidewave (Greenhouse new board, job <run id>,
about 10:15Z on <run id>). No confirmation email arrived from either company
(the manager checked the candidate's Gmail), so most likely neither went
through, but that is unknown: the app kept nothing of what the page showed.
The confirmation reader also never read Greenhouse's `/confirmation` or
Lever's `/thanks` address, and a job description's "Thank you for your
interest" hid a later "Thank you for applying" (both tallied as "thank you").
Now a new Greenhouse `/confirmation` or `?confirmation` URL or Lever `/thanks`
URL confirms, the longer phrases ("Thank you for applying", "We've received
your application") are counted on their own, fields the site marks invalid
after the click pause the run with the site's error text and the approval
withdrawn (retryable with `pnpm pipeline:retry`, since nothing was sent),
and refused, challenged, and unknown outcomes fail closed with local
evidence (a full-page screenshot and redacted text, mode 600, never sent to
Discord or a model) that `pnpm run:evidence --run <ref>` prints. Both runs
stay failed and are never retried automatically; the candidate checks those
applications on the sites. Regressions: the "post-submit outcomes" tests in
`recognition-planner.test.ts` and `run-lifecycle.integration.test.ts`, the
field-error and unconfirmed retry cases in
`automatic-retry.integration.test.ts`, `submit-evidence.integration.test.ts`,
and the post-submit scenarios of `pnpm test:browser:greenhouse` (the
confirmation redirect, the inline thanks under a description that already
says thank you, Lever's /thanks, field errors, a banner, a challenge, and a
silent click).

### Greenhouse's education block stayed empty on real boards

After run N, fresh automatic runs on 2026-11-20 still paused on School,
Degree, Discipline, and a date month: Ironvale (<run id>), Glowpath
(<run id>), and Tidewave (<run id>). A read-only capture showed the real ids
match run N's rule; the lists are async catalogs, and the school catalog
spells campuses "University of California - Berkeley", which a typed
"University of California, Berkeley" never equalled. On a local replica the
failed School search also left its menu open (Escape, then an empty fill
reopened it), absolutely positioned over Degree, Discipline, and the start
month, so their clicks timed out. Now a suggestion with exactly the same
words (punctuation, case, accents, and of/the/at/and/in ignored) is taken,
one at most; every list choice starts with no menu open; a failed search is
cleared, closed, and left without focus; and the catalog lists get longer to
load. Regressions: `recognition-planner.test.ts` (`matchSuggestion`),
`application-history.test.ts` (`sameNameKey`), and the Greenhouse scenarios
of `pnpm test:browser:greenhouse` (the "System - Campus" school, and a
no-match school that leaves only School unfilled).

### Ashby's location box and Yes/No questions could not be filled

Fernwave Sciences (<run id>) still paused on "Location" and on "Are you legally
authorized to work in the country this role is located in?". The captured
page's location input has no id and no name, so recognition gave it a
synthetic id the executor could not find; its required star is the question
title's `_required` class; Yes/No questions are button pairs over a hidden
checkbox, read as a checkbox that was ticked or skipped. Now a control with
neither id nor name is tagged `data-ia-control` (stable across
recognitions) and located by it, `_required` titles mark a question required,
Yes/No pairs are one radio question answered by clicking the button (kept
only when the button shows pressed), location suggestion rows are read, and a
fieldset's question title labels its radios. Fernwave's "…office and involves
working primarily in person. Are you willing and able to work from this
location?" now carries its real label (it read "Yes") and pauses: a plain
"Yes" would claim no relocation is needed. Regressions:
`recognition-planner.test.ts` (`recognizeFields` ref) and the Ashby scenario
of `pnpm test:browser:greenhouse`.

### Greenhouse question descriptions were not read

Ironvale (<run id>) asks "HISTORY WITH IRONVALE" and "CONFLICT OF INTEREST" as
short headings with the question itself in a `<id>-description` block, so the
labels named no question. Now a short label with no "?" takes its
description when the description is a question ("HISTORY WITH IRONVALE: Have
you previously applied to a position at Ironvale?"). Having applied before is
not having worked there, so it stays paused; conflict of interest stays
paused. Regressions: `question-mapper.test.ts` and the Greenhouse scenario of
`pnpm test:browser:greenhouse`.

### More saved-answer phrasings

Glowpath (<run id>) paused on "Do you have any immediate family that work at
Glowpath?", "What state do you currently reside in?", "Which university are
you currently attending?" (a campus-only list such as "Berkeley"), and "…
required to be in the San Francisco office. Are you ok with this
requirement?". Now "immediate family" maps to relatives_at_company, the
state-of-residence phrasings take the profile's address region (a US state
name or code matched to the other form among the options, exactly one), the
current-university phrasings take the profile school (same words, else the
one option naming only its campus, never "Other"), and "be in the <city>
office" maps to work_arrangement. Salary expectations, FDA/OIG debarment,
conflict of interest, export controls, DoD eligibility, "within 50 miles of",
and a preferred first name with no saved value still pause. Regressions:
`question-mapper.test.ts`, `recognition-planner.test.ts`, and
`application-history.test.ts` (`campusOption`).

### A family-in-health-care question was answered from the relatives fact

Glowpath (<run id>) asks "Are any of your immediate family members
practicing health care professionals that may use or purchase Glowpath
products?", which mapped to relatives_at_company (family working at the
company). Now a relatives question about products, purchases, customers,
clients, vendors, suppliers, or health-care practice is not mapped and
pauses. Regressions: `question-mapper.test.ts`.

### Unlabeled fields were sent to the voice drafter

Corvane (<run id>) paused on "Unlabeled textarea control 2", and every
paused textarea was offered to the voice drafter, which would write prose
for a question nobody could read. Now a field with the recognizer's
"Unlabeled … control N" label is never drafted. The label itself is still
open (see Open). Regressions: `voice.test.ts`.

### Postings behind an Apply link stopped with no form found

The 2026-11-20 07:00Z timer pass stopped the first postings from the new
posting sources with "No application form was found at <url>. It may sit
behind an Apply button": Example Capital Group's "2027 Agentic Engineering
Intern" (Jobvite), Mapwise Technologies' "Software Engineer Intern" and "Data
Science Intern" (iCIMS), and Example Consultants' "AI/ML Engineer Intern"
(iCIMS). Each page was a posting with an Apply link, not the form. Now a
page with no form has its own Apply entry followed once (`chooseApplyEntry`:
the same site, the same company domain, or a known ATS host; never "Apply
with LinkedIn", Indeed, sharing, referral, or another site; never on
Handshake), and the run reads the form there and saves that address.
iCIMS's Apply lands on an email-first account step and Jobvite's on a
data-consent step: both stop the run with a plain reason before anything is
typed (automatic runs are held, candidate-started ones end with the message;
the agent creates no account and gives no consent), and Jobvite and iCIMS are
recognized for display with the candidate approving each run. Regressions:
`ats-classification.test.ts` (kinds, `chooseApplyEntry`,
`applicationWallReason`), `run-lifecycle.integration.test.ts` ("posting
pages behind an Apply link"), and the Apply-link scenarios of
`pnpm test:browser:greenhouse`.

### Greenhouse's phone country never kept its choice

On Greenhouse's new boards (runs <run id> Ironvale, <run id> Glowpath,
<run id> Orbitline, <run id> Tidewave) the contact "Country" paused. The
phone-country list shows only the chosen dialing code ("+1") once
"United States +1" is picked, so the executor's check that the list shows the
option failed and the field came back unfilled; a profile country spelled
"US" or "USA" also matched no "United States +1" option. Now a shown dialing
code that ends the chosen option counts as kept, and Country options match
across the United States' spellings and a trailing dialing code (exactly one
match, else a pause). Regressions: `recognition-planner.test.ts`
(`matchCountryOption`) and the Greenhouse scenario of
`pnpm test:browser:greenhouse` (the fixture shows "+1").

### Greenhouse education fields paused although the profile holds them

The same Greenhouse runs paused on School, Degree, Start/End date month and
year: nothing mapped them. Now an education block is answered from the
profile: School typed into Greenhouse's searched list (or chosen by its exact
name from a native list), Degree through `chooseDegreeOption` (a curly
"Bachelor’s" counts; never a B.S. for a B.A.), Discipline from the field of
study, the start month and year from the education start month, and the end
month and year from the run profile's graduation date (the default profile:
the global answer, else the profile's date; the transcript profile: only its
2029 answer, never 2028). Anything missing pauses when required. The
application record now reports only a full-date graduation answer as
"answered on the form", never an End date month or year with the same fact
basis. Regressions: `recognition-planner.test.ts`,
`run-lifecycle.integration.test.ts` ("education block": 2028 default, 2029
transcript, pause without a 2029 answer), `application-history.test.ts`,
`application-record.integration.test.ts`, and the Greenhouse scenario of
`pnpm test:browser:greenhouse`. The date rule needs Greenhouse's education
ids (`start-month--0`, `end-year--0`, …): its employment block repeats the
same "Start date month" labels under `start-date-month--0` and the like, and
is never filled from education data (optional: left empty; required: a
pause; regressions in `recognition-planner.test.ts` and the fixture's
employment block).

### Generic sponsorship and authorization questions ignored the posting's country

Glowpath (<run id>: "Will you now or in the future require sponsorship for
employment visa status (e.g. F-1 STEM OPT, H-1B, TN, E-3…)"), Tidewave
(<run id>: "Will you require future sponsorship?", "Are you legally
authorized to work in the location of this job?"), and Orbitline
(<run id>: "We are unable to provide sponsorship for this position. Will you
require sponsorship for this internship?") paused as AMBIGUOUS: the mapper
read a country only from the question. Now authorization and sponsorship
questions take the question's own country, else the posting's one stated
country; a posting with no country or several still pauses. Regressions:
`question-mapper.test.ts`.

### A City, ST location matched no spelled-out suggestion

Orbitline's "Location (City)" (<run id>) and Fernwave Sciences' Ashby
"Location" (<run id>) paused: the profile's city and state abbreviation (for example
"Springfield, IL") matched no suggestion that spells the state out
("Springfield, Illinois, United States"). Now a US state's code and
name stand for each other in `matchSuggestion` (still exactly one match,
never a guess), and a "City, Region" value with no match is searched again by
the city alone. Regressions: `recognition-planner.test.ts` and the Greenhouse,
Ashby, and Lever scenarios of `pnpm test:browser:greenhouse` (fixture profile
region "CA").

### Preferred name fields paused although the profile holds one

Orbitline's "Preferred First Name" (<run id>) paused: no contact label
mapped it. Now "Preferred name" / "Preferred first name" fill the profile's
preferred name; with none, an optional field stays empty and a required one
pauses. It is never derived from the legal name. Regressions:
`recognition-planner.test.ts` and the Greenhouse scenario of
`pnpm test:browser:greenhouse`.

### Oracle Candidate Experience runs stopped at the email step

Nine Oracle Cloud HCM runs on 2026-11-24 (INL, Corvane, Vertiv, Stantec,
Worthington) stopped with "Oracle Cloud HCM asks for your email at <host>,
then emails you a one-time code, before its application form; the agent does
not take that step yet.": no adapter took `/apply/email`. Now
`packages/browser/src/ats/oracle-apply.ts` reads and drives the email, terms,
and PIN screens (derived from Oracle's public Candidate Experience bundle and
a read-only capture of two tenants' email steps), and
`packages/agent/src/oracle-email-step.ts` takes the step in start, continue,
and submit: the saved email is typed only when it is the mailbox the agent
reads, the terms box is ticked only under the standing data-consent setting
and logged with its exact text, and an emailed six-digit code is read from
the candidate's own mailbox (`oracle-verification-mail.ts`, never logged or
stored) and typed once, never resent. No code, several codes, a refused
code, a CAPTCHA, an identity check, an already-applied screen, or an
unrecognized step stops the run with a fixed reason. Oracle's default label
"I agree with the terms and conditions" is accepted under the standing
data-consent setting through the terms-of-use group (Track 8) and logged;
without the setting the run stops at the terms step with nothing typed.
Regressions: `pnpm test:browser:oracle-apply`,
`pnpm test:browser-worker:oracle`, `pnpm test:agent:oracle-code`. Boundary:
the PIN and section fixtures are derived, and the step was never run against
a live code.

### Oracle Digital Assistant's chatbot box was read as an Oracle question

Corvane's Oracle runs (<run id>, <run id>, 2026-11-20) paused on field
`oda-work-summary-text-area|input`, labelled "Discard" and later "Unlabeled
textarea control 2". It is not an application question: Oracle's public
Candidate Experience bundle draws it as the required work-summary box of
Oracle Digital Assistant's chatbot popup (`oda-summary`,
`<oj-text-area id="oda-work-summary-text-area">`), and the read-only capture
of 2026-11-24 found it on the email step's page. Now `collectControlsIn`
never reads a control inside an `oda-` element or `.oda-chat-wrapper` on an
Oracle Cloud host. Regression: the chatbot scenario of
`pnpm test:browser:oracle-apply` (fails on the old code).

### A button's label became a field on Oracle Cloud HCM

Corvane's Oracle run (<run id>) held on "Discard": button and reset inputs
were read as fields, and a button's inner label span (Oracle JET's
`oj-button-label`) could label an unlabeled control beside it. Now button and
reset inputs and controls with a button, link, menu item, or tab role are not
fields, text inside a button or link never labels a control, and an
unknown-kind control labelled only with an action word ("Discard", "Back",
"Next", "Submit"…) is dropped. Regressions: `recognition-planner.test.ts` and
the Oracle email-step scenario of `pnpm test:browser:greenhouse`
(`fixtures/oracle-apply-email.html`, derived, not captured).

### Ashby's success message was not read as a confirmation

Lumora's Ashby run (<run id>) ended failed with "no confirmation text was
recognized": Ashby replaces the form with its success container
(`.ashby-application-form-success-container`, role=status), whose message can
be the employer's own wording with no usual confirmation phrase. Now that
container counts as a confirmation when it appears after the submit click,
and "Thanks for applying" and "Your application has been submitted" are
confirmation phrases; nothing recognized still fails closed. The Lumora run
stays failed and is not marked submitted: the candidate checks the
application on the site. Regressions: `recognition-planner.test.ts` and the
Ashby confirmation scenarios of `pnpm test:browser:greenhouse` (default
message, custom message, none).

### Radio questions were typed into as text

Cloudrise's Lever run stopped with `locator.fill: Error: Input of type "radio"
cannot be filled` on "Non Applicable I am a national of a Member State of the
European Union…". The generic reader read each radio as its own field labelled
by its option, and the planner returned a fill for a remembered answer. Now
radios sharing a name are one choice question with their options, answered by
checking the radio whose label equals the option, the planner never fills a
radio, checkbox, list, or upload (it pauses), and the executor refuses to type
into one. Regressions: `recognition-planner.test.ts` and the Lever scenario of
`pnpm test:browser:greenhouse`.

### A type-ahead field's timeout stopped the whole run

Solvik and Fernwave Sciences (Ashby) stopped with `locator.fill: Timeout 30000ms
exceeded. waiting for getByLabel('Start typing...')`: the location box had no
label but its placeholder, so the filler looked for a label that did not
exist, and any page error ended the run with a raw Playwright message. Now
type-ahead fields are typed into and the matching suggestion picked (exact or
the only one, never a guess), the question text near an unlabeled control is
its label, and a field the page will not take becomes a pause with a plain
reason; before a submit click it holds the run with the approval withdrawn.
Regressions: `run-lifecycle.integration.test.ts` (timeouts at start, submit,
on the pipeline, and on a Workday step), `recognition-planner.test.ts`
(`matchSuggestion`), and the Ashby, Lever, and Greenhouse "Location (City)"
scenarios of `pnpm test:browser:greenhouse`.

### Ashby application sites were not recognized

Runs <run id> (Brightlane) and <run id> (Lumora) on jobs.ashbyhq.com were
"unknown" and held on "Unlabeled input control 1" (Ashby's "Autofill from
resume" parser box), "Name", "LinkedIn", and an optional "Cover Letter". Now
jobs.ashbyhq.com (and `ashby_jid=` pages) is kind `ashby`, proceeding like
Greenhouse; the parser box is not a question; "Name" fills the profile name,
"LinkedIn" the profile URL, the resume field the uploaded resume, and an
optional cover letter (or other non-resume upload, on any site) stays empty.
Regressions: `ats-classification.test.ts`, `recognition-planner.test.ts`, and
the Ashby scenario of `pnpm test:browser:greenhouse`
(`fixtures/ashby-application.html`, reduced from a read-only capture).

### Required markers and widget status text stayed in Lever labels

Threadline Studio's Lever run (<run id>) held on "Full name✱", "Phone ✱",
"Current location ✱No location found. Try entering a different
locationLoading", and a data-retention consent checkbox. Labels kept "✱" (only
a trailing `*` was stripped) and the whole wrapping label's text, including the
location widget's hidden status texts. Now required markers (`*`, `∗`, `✱`,
`＊`, "(required)") are stripped and mark the field required, label text skips
controls, live regions, status widgets, and hidden elements, a wrapping label
uses its own label element, "Full name", "Phone", and "Current location" map to
the profile, and a consent checkbox always pauses with "consent checkbox:
needs your OK". Regressions: `recognition-planner.test.ts` and the Lever
scenario of `pnpm test:browser:greenhouse` (`fixtures/lever-application.html`,
derived from Lever's public form markup).

### Ashby and Lever postings lost their structured country

"No country is stated" held Brightlane (Ashby location "Hybrid"), Threadline
Studio (Lever "Seoul"), and Fernwave Sciences (Ashby "South San
Francisco"), while Solvik ("Berlin") and Cloudrise ("Paris") were started
instead of ruled out. Discovery passed only the location string, dropping
Ashby's postal address and Lever's country code, and the extractor never read
a bare city. Now Ashby's address, Lever's country, and Greenhouse's offices join
the `Location:` line, a short table of unambiguous well-known cities decides
when nothing else is stated ("City, ST" and countries win), and the list's
column is added when the board's location names no place. Postings stored
before the fix keep their old snapshot until `pnpm backfill:extraction`.
Regressions: `testing-harness/jobs/github-list-source.test.ts` and
`normalization-contracts.test.ts`.

### Workday's invisible reCAPTCHA badge read as a CAPTCHA

The Workday account reader counted any visible `iframe[src*="recaptcha"]` or
`iframe[title*="captcha"]` as a CAPTCHA, so the invisible reCAPTCHA Enterprise
badge (titled "reCAPTCHA") would hold account creation. Now it uses
`challenge.ts`'s visible-challenge rule (the badge and the hidden token are not
a challenge) plus visible hCaptcha and Turnstile frames and Workday's robot
text. Regression: the `?markup=real` scenario of
`pnpm test:browser:workday-account`, which carries the badge.

### Hidden CAPTCHA token fields held runs as CAPTCHAs

In the live pass of 2026-11-20, Greenhouse runs (<run id> on
job-boards.greenhouse.io/orbitline, <run id> on glowpathinc) were flagged
with a CAPTCHA safeguard. Every new Greenhouse board loads the invisible
reCAPTCHA Enterprise badge and its hidden `g-recaptcha-response` textarea; the
generic reader labelled that textarea by its name, and the safeguard pattern
matched "recaptcha" (it also matched any question containing "challenge").
Now the token fields (`g-recaptcha-response`, `h-captcha-response`,
`cf-turnstile-response`) are not controls, only CAPTCHA wording is a
safeguard, and `packages/browser/src/challenge.ts` pauses a run only for a
challenge the candidate would see (a visible reCAPTCHA checkbox or image
challenge, hCaptcha, Turnstile, DataDome, or a human-verification page); a
challenge or a refusal after the submit click holds the run. Detection only
reads the DOM. Regressions: `testing-harness/browser-worker/recognition-planner.test.ts`,
`testing-harness/browser/greenhouse-fixture-run.ts` (`pnpm test:browser:greenhouse`),
and the challenge scenarios in `run-lifecycle.integration.test.ts`.

### Greenhouse's new board forms were read without labels

The same pass held Greenhouse runs (<run id>, <run id>, <run id> on tidewave,
<run id> on ironvaleindustries, which redirects to job-boards.greenhouse.io)
with "Unlabeled input control N" questions, two "Attach" fields that needed a
document, and "How did you hear" options (LinkedIn, Glassdoor, Indeed,
Referred by a friend) as separate questions. The generic reader ignored
aria-labelledby, so react-select lists were plain text inputs and their
hidden required inputs became unlabeled controls; the file inputs' own labels
say "Attach" (the group's label says "Resume/CV" or "Cover Letter"), and the
filler located every field by label, so both uploads would hit the first;
each checkbox of a fieldset was its own field. Now labels come from
aria-labelledby first, an "Attach" upload takes its group's label, fields are
located by id, react-select lists are one select with their options and the
hidden inputs are skipped, a checkbox fieldset is one question (the
How-did-you-hear group answered from the saved `how_heard` rule), and Discord
notices sum up any unlabeled fields in one line. Regressions:
`pnpm test:browser:greenhouse`, `recognition-planner.test.ts`, and
`testing-harness/agent/discord-notify.test.ts`.

### Workday's create-account step was treated as application questions

Runs <run id> (employer-a.wd115) and <run id> (employer-b.wd3) paused on "Email
Address", "Password", and "Verify New Password", so the account flow never
ran. Real Workday sites draw the apply flow, with its "Create Account/Sign
In" step, before the account form: entering saw the flow, the sign-in check
ran before the password field existed, and the walk read the account step's
`formField-*` containers as questions. The account screen also always wraps
the create button in `noCaptchaWrapper` with no challenge inside, which the
account reader took for a CAPTCHA. Now entering reads the active step, a walk
that meets the account step or a password field signs in (or creates the
account) once and walks again, and only a frame inside `noCaptchaWrapper`
counts as a CAPTCHA. Regressions: the real-markup scenario in
`testing-harness/browser/workday-account-run.ts`
(`pnpm test:browser:workday-account`, fixture `?markup=real`) and the
account-step scenarios in `run-lifecycle.integration.test.ts`.

### Workday postings outside the US were read without a country

Example Consulting's "Data & AI Consultant - INTERNSHIP - Milano" (employer-b.wd3) was not
recognized as non-US: "Location: no country is stated". Discovery passed only
Workday's `location` ("Milan"), and the extractor deliberately never reads a
bare city as a country. Now the posting's own country descriptor joins a
single location ("Location: Milan, Italy"); multi-location values are kept as
is. Postings stored before the fix keep their old snapshot. Regression:
`testing-harness/jobs/github-list-source.test.ts`.

### Answering a held run reported "remembered" backwards

`answerRunPause` returned `remembered: resolution.status === "ANSWERED_ONCE"`,
which is true when nothing was stored (remember off) and false when a fact was
stored, so the run panel said "Answer recorded and remembered" for answers it
had not kept and the opposite for answers it had. Found 2026-11-19 (run H).
Now `remembered` is true exactly when an answer was saved to candidate facts
or question memory, and the result carries the outcome and its reason.
Regression: "reports remembered only when a fact was stored" in
`testing-harness/agent/question-answers.integration.test.ts`
(`pnpm test:agent:answers:local`).

### Sensitive, blocked, and ambiguous questions could not be answered for a run

Answering a held run's demographic (EEO) pause, a pause the mapper blocks
(protected wording or an attestation), or an ambiguous catalog question threw
"That answer did not resolve": the pause's question was mapped, and a
`REQUIRES_CONFIRMATION` (blocked or protected) or `AMBIGUOUS` result was not
among the usable ones, so the answer was refused and the Discord notice's
"answered for this application only" questions had no way to be answered.
Found 2026-11-19 (run H). Now those answers are recorded for that run only,
never stored, and the timeline records why. Regression: "records attestation,
protected, sensitive, and ambiguous answers once instead of refusing them" in
`testing-harness/agent/question-answers.integration.test.ts`.

### An answered select was typed into on continue

`continueBrowserRun` turned every answered pause into a `fill` decision, so
an answered select or radio question was sent to `fillField`, which Playwright
refuses on a `<select>`, and the continued run failed on real forms. Found
2026-11-19 (run H). Now an answer matching exactly one offered option is
chosen, a single checkbox answered yes is checked and one answered no is left
unchecked, a text answer fills as before, and an answer that fits no option of
its list reopens the pause instead of being typed into the list. Regressions:
"chooses an answered select and leaves an answered-no checkbox on continue" in
`testing-harness/agent/question-answers.integration.test.ts`, and "chooses an
answered list option on continue, and reopens an answer that is not among the
options" in `testing-harness/browser-worker/run-lifecycle.integration.test.ts`.

### Failed requirement classification silently kept rule labels stamped as model labels

The live pass of 2026-11-19 logged "Requirement classification fell back to
deterministic rules: fetch failed" once and "...: The model exhausted its
output budget before returning JSON; lower the batch size or raise
maxOutputTokens." many times, yet the real workspace showed every
`job_requirements` row as `MODEL` (718) and none as `DETERMINISTIC`. The
classifier's catch returned the rule label for every line of a failed batch,
and because a decision existed for each index, ingestion stamped those rows
`MODEL`; ingestion also silently kept the rule label for any line the model
left unlabelled. Decisions (eligibility, preparation, automatic runs) could
therefore rest on rule labels. Now a model classifier returns a model label
for every line or the posting is held (`requirement_label_holds`, migration
0027) with no requirement rows, not analyzed, prepared, or run, and retried on
each pipeline pass; the provider retries network errors, 500/502, and 429/503,
and the classifier sends `reasoning_effort: "medium"`, splits batches on budget
overruns, bad or incomplete answers, and timeouts, and retries single lines at
doubled budgets. Automatic runs refuse any posting with a rule-labelled
requirement. `pnpm labels:hold-fallback --apply` marks postings labelled
before the fix for relabelling. Regression:
`testing-harness/agent/requirement-labels.integration.test.ts`
(`pnpm test:agent:labels`), with the rule-label and hold gates in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts`.

### Graduate enrollment under a neutral heading passed the graduate-only exclusion

Example Analytics' "Quant Developer Intern" (2026-11-17) listed "Current
students pursuing a master's degree in mathematics, Physics, Financial
Engineering, Quantitative Finance, or a related quantitative field." under
"Education and Experience:". With no hard cue in the line or heading the
extractor left it PREFERRED (confidence 0.4), and the exclusion read only HARD
lines, so the posting was QUALIFIED for a bachelor's candidate who excludes
graduate-only internships. The exclusion now also reads such a defaulted line
when it states current graduate enrollment and has no preference wording
(`defaultedEnrollmentStatement` in `packages/matching/src/eligibility.ts`);
a Preferred heading or "preferred" wording keeps it soft. Regression:
`testing-harness/matching/eligibility-fit.test.ts`.

### The Vansh list never produced a posting

Every row of `vanshb03/Summer2027-Internships` links through `go.vansh.nyc`
short links (all 2,459 active rows on 2026-11-17), which the board resolver did
not recognize, so each was counted as needing manual review. Discovery now
follows a Vansh short link one redirect, without following it further, and
resolves the board link it names. Regression:
`testing-harness/jobs/github-list-source.test.ts`.

### Fit estimates inflated keyword overlap and hid uncertainty

Every posting received 50 baseline points; five technology matches added 30,
while arbitrarily many missing technologies lost at most 12. Unspecified work
mode and unrelated approved-claim counts could add bonuses. Fit was independent
of eligibility, so a 100-point posting could simultaneously be not qualified.

New version-2 local estimates measure proportional coverage without those
bonuses. Grounded AI capability assessments add contextual comparisons and
unknown counts, retain separate eligibility, and invalidate on changed inputs.
The UI identifies local, legacy, AI, and stale estimates. Citation validation
and synthetic regressions do not establish ranking accuracy; representative
human-reviewed calibration is still outstanding.


### Switching dashboard tabs rendered the entire workspace

Overview and Applications materialized all 2,619 posting summaries; Review
hydrated all 926 entries and their resume histories. Warm local development
requests took about 1.5–2.4 seconds and returned 2–3 MB. Pipeline counts repeated
the summary projection, and location/latest-resume lookups lacked indexes.

Fixed with bounded Overview reads, paginated Applications/Review queries,
aggregate counts, latest-only resume comparisons, read indexes, and loading
boundaries. Global counts and Refresh all retain workspace-wide scope; batch
checkboxes explicitly cover the visible page. Regressions: `bounded dashboard
reads` in `job-list.integration.test.ts` and `large lists stay bounded when
navigating tabs and pages` in `review-queue.spec.ts`. Jobs still renders its
existing 50 full cards per page; its payload has not been reduced by this fix.


### Graduate-only requirements were ignored when the model labeled them "graduation"

Example Software's "Intern, AI Agent Evaluations" states "Currently enrolled in a MBA." The
model classified the line with subject GRADUATION, which the matcher treats
as a duplicate of the graduation-date constraint check; the posting states
no graduation window, so the line produced no finding and the job showed
65/100 needing review for unrelated skills, despite the candidate's B.A. and
their graduate-internship exclusion. "MBA" was also not recognized as
graduate study at all. The requirement's "confidence 0.90" (how sure the
reading of the line is) read as if it scored the candidate.

Fixed: degree level is read from the requirement text, not the model's
subject label (with program wording such as "enrolled" or "pursuing" so a
tool name like "MS SQL Server" is not a degree); MBA, M.Eng, M.Sc, MPH, MPP,
J.D., and law school count as graduate study; titles such as "Intern - MBA"
are covered by the exclusion; and the label now reads "reading confidence
90%". Re-analyzing 377 unprepared postings moved 7 graduate-only roles to
not qualified. Regression: `checks graduate programs like an MBA from the
requirement text` in `testing-harness/matching/eligibility-fit.test.ts`
(it rated the Example Software case QUALIFIED before the fix).

### Real application forms failed recognition or filling

The 2026-09-24 fill pass exposed three defects, reproduced read-only against
the live pages. Ashby forms render client-side: the Example AI form had 0
controls at load and 45 six seconds later, so every Ashby run stopped with
"No application form was found". An Example Aerospace Greenhouse question label ran
past the 300-character field limit, and recognition rejected the whole form
with a validation error. Greenhouse education "Start date year" boxes are
`type=number`, and the question mapper's `start date` rule mapped them to
the internship availability date, so the planner tried to type a full date
into a year box (on a text box it would have filled the wrong fact).

Fixed: the Playwright adapter waits for a form's controls to appear and
settle before reading; recognition trims labels, ids, and option lists to
their limits (options raised to 500); `type=number` is its own field kind,
filled only with numeric values; and year/month/day components are
excluded from the availability-date rule. Regressions: the fixture run's
delayed-form step (0 fields without the wait, 3 with it),
`real-form robustness` in `recognition-planner.test.ts`, and the mapper's
date-component test. `pnpm pipeline:run --retry-stopped` retries the
affected applications.

### Automatic browser runs failed under tsx with "__name is not defined"

The first `pnpm pipeline:run` with auto-apply on 2026-09-23 stopped all 107
automatic runs before filling anything: `collectControlsIn` threw
`ReferenceError: __name is not defined` inside the page. tsx compiles with
esbuild keepNames, which wraps inner functions in an `__name` helper that
does not exist in the page when the function is passed to `evaluate()`.
Dashboard-started runs (Next's compiler) were unaffected, and the fixture
run hid the defect by installing its own page shim. Each failure was also
recorded as a one-time stop, so the pipeline would never have retried them.

Fixed: `createPlaywrightPage` installs a string no-op `__name` in the page,
now and on every navigation, before any evaluate. Only real stops (sign-in,
no form) are recorded once as "Automatic browser run needs you"; other
failures are logged as "Automatic browser run failed" and retried, so the
107 earlier markers no longer block. Regressions: the fixture run without a
test shim (it failed with the same error before the fix) and `retries an
unexpected failure on the next pass` in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts`.

### Dashboard ignored the root model settings

`MODEL_API_BASE_URL`, `MODEL_API_KEY`, and `MODEL_API_MODEL` are set only in
the repository-root `.env`, but `next dev` reads only `apps/dashboard/.env*`.
On 2026-09-23 the running dashboard process had no `MODEL_API_KEY`, so every
ingestion and board check from the app classified requirements
deterministically; the 70 recorded model invocations all came from scripts
that loaded `.env` explicitly. Passing Node's `--env-file-if-exists` to the
Next CLI fails because Next forwards it to workers through `NODE_OPTIONS`,
where Node rejects it.

Fixed: the dashboard's `dev`, `build`, and `start` scripts run through
`apps/dashboard/scripts/with-root-env.mjs`, which loads the root `.env`
(shell variables win) before launching Next. Verified by starting an owned
dev server on port 3107 with a temporary data directory and the model
variables unset in the shell: it served `/jobs` and its process carried
`MODEL_API_KEY`. The browser harness launches `next dev` directly and is
unaffected. This is a launch-path check, not an automated regression.

### Submit click did not reach Handshake, and a failed run could not be retried

The Example Co submit step on 2026-09-22 clicked "Submit Application" by
dispatching `element.click()` from a page script, read the page once, found
no confirmation, and closed the browser. Handshake recorded no application.
A script-dispatched click is untrusted and may be ignored, and closing
immediately would cut off a submission still in flight. The run was marked
failed with the job left in APPLYING, where `startBrowserRun` refused to
start a new run. Reproduced with the Handshake-style fixture: a submit
handler that ignores untrusted clicks and confirms after 1.5 seconds failed
with the same message.

Fixed: the adapter picks the submit control in the page and clicks it with a
real Playwright mouse click, and `submitAndConfirm` keeps the page open for up
to 30 seconds watching for a new confirmation (reporting separately when the
dialog closed without recognizable text). A new run may start when the
latest run failed or was cancelled and no run was ever submitted. Regressions:
the fixture's trusted-only, delayed submit; `submission confirmation` in
`testing-harness/browser-worker/recognition-planner.test.ts`; and `retrying a
browser run` in `testing-harness/browser-worker/run-lifecycle.integration.test.ts`.

### Quick apply check raced Handshake's rendering

`openApplicationDialog` counted "Quick apply" buttons right after the page's
load event, but Handshake renders them later. The Example Co run's start step
found the button; its submit step, on 2026-09-22, did not and stopped with
"This Handshake posting shows no Quick apply button" before clicking
anything (the run stayed awaiting approval). The fixture reproduction also
showed that, without a dialog scope, the submit helper could click a submit
button inside a hidden dialog.

Fixed: the adapter waits up to 15 seconds for a visible Quick apply button,
and the submit helper ignores hidden or disabled controls. Regression: the
Handshake-style fixture renders its Quick apply buttons 1.2 seconds after
load and checks that a hidden dialog's submit is refused.

### Browser runs do not open Handshake's Quick apply dialog

The Handshake worker recognizes whatever form is on the loaded page and, at
submission, clicks the first button whose text matches `submit|apply`
(`clickSubmitInPage` in `packages/browser/src/handshake-executor.ts`). On a
real Handshake job page (`/jobs/<id>`, read on 2026-09-22) the page's own
controls include two "Quick apply" buttons and no application form until
Quick apply is opened. A run would plan against the page's search controls,
and the approved submit step would click "Quick apply" instead of the
dialog's final submit. The worker was only ever exercised against the local
fixture form.

Fixed: Handshake-internal runs click "Quick apply" and scope recognition,
filling, and submission to the "Apply to …" dialog (structure read live
2026-09-22); a matching pre-attached resume is kept, any other attachment
stops the run, and the submit click never counts "Quick apply" or cancel
controls. Confirmations must newly appear after the click. Regressions: the
Quick apply dialog tests in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts` and the
Handshake-style dialog in `testing-harness/browser/fixture-run.ts`. Verified
live: the Example Co application was submitted through this path on
2026-09-22; afterwards the job page shows "Applied on <date>" and "Withdraw
application".

### Interest answer points to experience that is not in the package

With no allowed evidence claims, `buildAnswers` still writes "names <stack>,
which matches work described below." although no "most relevant experience"
answer follows, plus a double space before "names". Seen in the Example Co
package prepared on 2026-09-22 (`packages/writer/src/package-builder.ts`).
The sentence is presentation text, so the verifier cannot catch it.

Fixed: the sentence cites described experience only when a relevant-experience
answer exists, without the stray space. Regression: `mentions described
experience only when the package describes some` in
`testing-harness/writer/package-builder.test.ts`.

### GitHub skill claim overstates dependency and documentation evidence

`extractSourceSignals` scans README and manifest files as well as source files,
then labels every match `Source contains implementation evidence for ...`.
In the 2026-09-22 temporary sync of `owner/sample-repo` at
`<commit>`, the Playwright claim had
three evidence items: a `package.json` test script and two testing-harness
README lines. None was an implementation file. Keep this claim pending; a
dependency or documentation mention should be described as such, and skill
claims should require matching implementation evidence.

Fixed: `extractSourceSignals` reads only `source` files, so README lines and
manifest scripts no longer produce "implementation evidence" claims; manifest
dependencies keep their own dependency claims. Regression: `claims
implementation evidence only from source files` in
`testing-harness/github/repository-contracts.test.ts`. Claims an older sync
already stored stay (as PENDING, never used by the writer) until their files
change or the repository is registered fresh; the sample sync above ran only
in a disposable database.

### Connect Handshake closed the sign-in window before sign-in

A signed-out visit to `https://app.joinhandshake.com/login` redirects to
`/access`, Handshake's sign-in page. `classifyHandshakeUrl` read any app path
outside its sign-in list as signed in, so `/access` counted as "connected":
the agent closed the window about a second after it opened and recorded a
false "connected" status. Runs could also have treated the sign-in page as a
signed-in page. Reported by the candidate and reproduced with a throwaway
browser on 2026-09-22.

Fixed: `/access` is a sign-in path, and the agent no longer closes the window
on its own before a 10-minute timeout; the candidate closes it and the last
Handshake page seen decides the status. Regressions: the `/access` cases in
`testing-harness/browser-worker/handshake-session.test.ts` and the Connect
Handshake window tests in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts`.

### Browser verification rewrites the tracked `next-env.d.ts`

`testing-harness/browser/run.mjs` sets `NEXT_DIST_DIR=.next-verify`, and Next.js
rewrites `apps/dashboard/next-env.d.ts` to import route types from that directory.
The tracked file is left modified after every `pnpm test:browser` run and has to be
restored by hand before a commit.

Reproduce: `git diff --quiet -- apps/dashboard/next-env.d.ts && pnpm test:browser && git diff -- apps/dashboard/next-env.d.ts`

Confirmed 2026-09-22. Not a product defect; it makes verification leave churn in the
working tree, so a real change can be missed in a diff review. A fix likely means
restoring the file inside the runner's existing cleanup block, next to where it
removes the temporary data directory.

`next build` rewrites it too (to `./.next/types/routes.d.ts`), so
`pnpm agent:finish` left the same churn through its build step.

Fixed: `testing-harness/support/next-env.mjs` snapshots the file; the browser
runner restores it in its cleanup block (`BROWSER_RUN_REPORT` includes
`nextEnvRestored`) and `agent:finish` restores it after every step. Verified:
the file is unchanged after `pnpm test:browser` and after
`pnpm agent:finish profile`.

### Every file-upload field received the resume

`planAutofill` turned any file field into a resume upload, so a "Transcript",
"Cover letter", or unlabeled attachment field would have received the resume.
Confirmed by reading `packages/browser/src/autofill-planner.ts` on
2026-09-22, while adding transcript uploads.

Fixed: upload fields are routed by label (`classifyUploadRole`). Only resume or
CV fields receive the resume, only transcript fields receive the stored
transcript, and anything else pauses for the candidate. Regression:
`uploads the resume and transcript only into matching fields` in
`testing-harness/browser-worker/recognition-planner.test.ts`.

### Legacy placeholder job crashed the dev dashboard

A Milestone 0 `jobs` row with ID `seed-internship` survived the posting-schema
migration without a current snapshot. The dashboard list projected it through
the UUID-backed `jobSummarySchema`, raising `Invalid UUID` on dev startup.
Confirmed against the local database on 2026-09-22.

Fixed: posting lists and overview counts include only jobs with a current
normalized snapshot. The legacy row remains in the database. Regression:
`ignores pre-normalization placeholder jobs that have no captured snapshot`
in `testing-harness/jobs/ingestion.integration.test.ts`.

### Discovery re-analysis regressed live applications

Re-pasting a batch re-ran `evaluateAndPersistMatch` over every ingested
posting, including ones already submitted or interviewing. Analysis rewrites
the posting status, so a live application was dragged back to an early stage
and re-prepared. Found by lifecycle simulation 2026-09-22: two submitted
postings reverted after a re-paste.

Fixed: the discovery orchestrator skips ingestion, analysis, and promotion for
postings past the approval gate (`APPROVED` through `WITHDRAWN`) and reports
them as `skippedJobIds`. The repository also rechecks status under its write
lock if an application becomes live during asynchronous classification.
Regression: `leaves live applications untouched when their text is pasted
again` in `testing-harness/jobs/discovery.integration.test.ts` uses revised
posting text and verifies that the current snapshot and snapshot count stay
unchanged. `protects a posting that becomes live while classification is pending`
in `testing-harness/jobs/ingestion.integration.test.ts` covers the write-lock
guard.

### Company-source rate limit never tripped across calls

`fetchCompanySource` built a fresh in-memory rate-limiter bucket on every
call, so the per-minute limit only applied within a single call and never
across polls. Found by simulation review 2026-09-22.

Fixed: the last attempt persists on `discovery_sources.last_fetched_at`
(migration `0010_discovery_fetch.sql`); the minimum interval derives from
`rate_limit_per_minute` at read time, and the reservation occurs before network
I/O, including failures. Regression: the company-source fetch test asserts an
immediate second poll is refused without fetching.

### Discovery imported the same posting from separate boards

Discovery compared content only within one batch and looked up persisted jobs
by exact source URL. Two boards exposing the same company, title, and full
posting text under different URLs created two jobs. The batch repost key also
discarded distinct descriptions under one company and title. Reproduced in
disposable SQLite on 2026-09-23.

Fixed: discovery checks normalized company, title, and full posting text
against current snapshots before ingestion, and its batch key uses the same
identity. Duplicates count in the run and do not re-enter analysis or the
review queue. Distinct descriptions remain separate. Regressions:
`skips the same posting when two boards expose it under different URLs`,
`keeps distinct requisitions that share a company and title`, and
`keeps source-free postings from different companies even when their body text matches` in
`testing-harness/jobs/discovery.integration.test.ts`.

### Public board list items lost hard requirements

The bounded five-source acceptance check on 2026-09-23 imported 28
Greenhouse/Lever postings with zero extracted requirements. Most public API
descriptions supplied encoded HTML list items, but the board text converter
turned each `<li>` into a newline. The requirement extractor recognizes
bullets, so explicit degree requirements disappeared. Five postings with
stated PhD requirements were then marked `QUALIFIED` against a profile that
did not establish doctoral study. Independently, the degree check could pass a
PhD requirement from matching subject words in a bachelor's degree.

Fixed: public board conversion preserves list items as bullet lines, and a
doctorate-only hard requirement yields `NEEDS_REVIEW` unless the recorded
degree establishes doctoral study. A stated lower-degree alternative can still
pass on its own evidence. Regressions: `preserves encoded HTML list items as
grounded requirement bullets` in
`testing-harness/jobs/github-list-source.test.ts` and `pauses on a
doctorate-only requirement when the profile records only a bachelor's degree`
in `testing-harness/matching/eligibility-fit.test.ts`.

### Answered automatic runs were never submitted by the auto-submit policy

On 2026-11-24 the candidate answered the last open question of the real
Contoro run `<run id>` (Ashby, started by the pipeline) with
`pnpm run:answer`. The run reached the submit step with no open pause, but
`advancePipeline` called `submitAutomatically` only right after
`startBrowserRun` in the same pass, so a run that became clean later
(through `run:answer`, the application page, or a later pass) waited for a
human approval indefinitely, against the candidate's 2026-11-21 decision that
an application that asked a question should still be submitted
automatically; run:answer also printed that a paused run is never submitted
automatically. Now each pass with the auto-submit policy first takes such
runs (`continuedAutoSubmitRuns`, `packages/agent/src/continued-auto-submit.ts`)
through the same `submitAutomatically` check (target and AI fit, company cap,
graduation profile, daily cap), never a run the candidate started or one
whose submit was approved, attempted, or may have reached the site, and
run:answer prints what happens next. Regression:
`testing-harness/agent/continued-auto-submit.integration.test.ts`
(`pnpm test:agent:continued`).

### Dover's Cloudflare Turnstile went unseen, so automatic submits failed unconfirmed

On 2026-11-24 five automatic Dover submissions (jobs.dover.com, where
app.dover.io links redirect) failed with "The submit button was clicked but
no new confirmation appeared". Each post-submit screenshot shows the filled
form, the Apply button, and an unchecked Cloudflare "Verify you are human"
Turnstile widget above it (one with the widget's area still blank), and no
thank-you, toast, or field error. Cause: Turnstile draws its frame inside a
closed shadow root, so `findVisibleChallengeIn`'s iframe scan never saw it and
its text is inside the frame, not the page body; `submitBrowserRun` also
checked for a challenge only on opening, before the widget rendered. Fix: the
Playwright page's `visibleChallenge` also reads the browser's frame tree and
counts a shown `challenges.cloudflare.com` frame (visible, at least 20×20 px;
never evaluated in, clicked, or typed into) as a Turnstile challenge, and
`submitBrowserRun` reads the page again after filling, right before the click:
a widget found there withdraws the approval and pauses the run as a safeguard
with nothing clicked; one drawn by the click holds the run as challenged with
evidence. The five runs stay failed with their possible-submission holds.
Regressions: the Dover `?turnstile=` scenarios in
`testing-harness/browser/greenhouse-fixture-run.ts`
(`pnpm test:browser:greenhouse`), "holds a run whose CAPTCHA appears while the
form fills" in `testing-harness/browser-worker/run-lifecycle.integration.test.ts`
(`pnpm test:browser-worker:local`), and `isTurnstileFrameSource` in
`testing-harness/browser-worker/recognition-planner.test.ts`
(`pnpm test:browser-worker:fast`).

### Inline hard requirements were not extracted

The bounded real-source recheck reanalyzed 27 postings and left one Greenhouse
posting with zero requirements. Its description states “Proficiency with
Python is required” inside a paragraph, not a bullet. Before the candidate
enabled a graduate-internship exclusion, all five extracted hard PhD
requirements produced `NEEDS_REVIEW` verdicts. The saved preference now
excludes graduate-only roles; the posting that explicitly allows a B.S.
alternative remains for candidate review.

Fixed: deterministic extraction recognizes applicant-directed prose sentences
with their own explicit requirement cue and preserves their exact spans. A
guarded repository operation replaces requirement rows only for the expected
current snapshot and only before application preparation. Regressions:
`extracts explicit inline requirements without treating general prose as
requirements` and `repairs only grounded requirements on the expected non-live
snapshot` in the jobs harness. The one affected real Example Trading posting was
repaired from its existing snapshot on 2026-09-23: it now has the stated hard
Python requirement and a `NEEDS_REVIEW` verdict. Its snapshot stayed unchanged,
and no current Greenhouse/Lever posting has zero extracted requirements.

## Resolved: AI fit blocked by missing extracted requirements

Example Bank's Summer 2027 Data Management Intern has non-bulleted minimum education,
experience and enrollment qualifications in the stored full description. The
extractor missed them; the original skill/experience-only AI coverage workflow
then refused to assess the posting. Version-2 competitiveness analysis reads
the full description directly and no longer depends on those extracted rows.
The underlying non-bulleted qualification extraction gap remains open for the
separate deterministic eligibility workflow. Training objectives must not be
converted into prior-experience requirements. Model assessments remain
uncalibrated and cannot establish hiring probabilities.
