# Voluntary self-identification questions the candidate already answered still held applications

Found 2026-11-28 (blocker ba1273d03c4, "a sensitive or self-identification question": 23 applications, 3 held only by it).
The candidate's saved answers were present; each held question failed one of the deterministic gates or the executor.

Causes (run ids are the held runs' first eight characters; no saved value is recorded here):
1. Ashby checkbox groups (Abridge <run id> and Sierra <run id> pronoun, ethnicity, and sexual orientation groups; Strava <run id> and <run id> "I identify my ethnicity as (mark all that apply):") paused with "the option was not found": Ashby names each box after its own option, and `collectControlsIn` took the first box's name as the group's id, so `chooseOption` found only the first box.
2. Lever's "I identify my ethnicity asSelect all that apply" (Tinder <run id> and <run id>, Hermeus <run id> and <run id>): the concatenated "asSelect" failed the "select all that apply" check's leading word boundary.
3. No decline option: Hermeus "What gender do you identify as?", INL <run id> and <run id> "Sex", Schonfeld <run id> and <run id> "Please identify your race", Illinois Tool Works <run id> and <run id> "Please indicate if you are Hispanic or Latino".
4. GCM Grosvenor <run id> "Are you of Hispanic, Latinx or Spanish origin?" and Illinois Tool Works' label were not `eeo` questions, so they paused as ordinary questions.
5. CarGurus <run id> and <run id> "LGBTQIA+ identity" was not an `eeo` question, and Toyota Research <run id> and <run id>'s LGBTQ community question was refused as an LGBTQ+ prompt.
6. CarGurus "Transgender identity": "I do not identify as transgender" matched no not-transgender wording.
7. CarGurus "Veteran status": "I am a veteran or active military" matched no veteran wording.
8. Lockheed Martin <run id> and <run id> "Please select your Protected Veteran Status": "I am not a protected Veteran / I prefer not to answer" was dropped as a decline option, leaving no option for a not-protected answer.
9. INL and Corvane <run id> and <run id> veteran-classification checkboxes ("Disabled Veteran", "Armed Forces Service Medal Veteran", "Recently Separated Veteran") and the newly separated veteran's discharge date paused, though a saved not-a-veteran answer leaves them empty.
10. Strava's "What are your personal gender pronouns?" radio and text questions were `eeo` questions because of the word "gender", so the saved pronouns answer was never used.

Fix (Track 82): `packages/browser/src/handshake-executor.ts` tags a checkbox group whose boxes carry different names and checks its option inside the group, through the option's label when the box refuses the click; `packages/browser/src/ats/field-roles.ts` makes Hispanic, Latin-, and LGBT wordings `eeo` and pronoun questions not; `packages/browser/src/ats/self-identification.ts` fills gender, race, and Hispanic/Latino lists of at most 100 characters without a decline option, reads Lever's concatenated hint, answers combined options by their first part, answers LGBTQ+ membership from the saved orientation and transgender answers, adds the transgender, veteran, and mixed-race wordings, and leaves optional veteran classifications empty (`veteranClassificationLeftEmpty`, applied in `resolveFields` and `planAutofill`); `packages/domain/src/question-answer-memory.ts` never stores LGBTQ+ or "Latine" answers.
Regressions: `testing-harness/browser-worker/self-identification.test.ts` ("held self-identification questions (Track 82, fictional answers)"), `self-identification.integration.test.ts`, `testing-harness/domain/question-answer-memory.test.ts`, and `pnpm test:browser:ashby-demographics`, which fails on the old executor with "the option was not found".
Still held, with no saved answer that settles them: CarGurus "I am not a veteran or active military" (whether the candidate serves now), military service, branch, and status questions, and military-spouse questions.
Not fixed here: Corvane and Vertiv Oracle gender and veteran lists read as text (bugs/open/oracle-address-lists-and-self-identification-lists-still-pause.md), Littelfuse <run id>'s Workday ethnicity checkboxes read with no options, and ParetoHealth <run id>'s clipped equal-opportunity attestation.
The stop re-check skips sensitive pauses, so the held runs pick these fixes up through `pnpm pipeline:retry --held`.

Round 2: the round-1 recheck's fictional probes found that the widened EEO wordings let non-identity questions be answered from protected answers ("Are you interested in joining our LGBTQ+ employee resource group?", "Do you have experience working with LGBTQ+ communities?", "Are you a member of the Latinx Professionals Association?", "Do you speak Spanish? (Hispanic markets role)", and the older "Are you interested in our disability ERG?").
Fix: `isIdentityQuestion` in `packages/browser/src/ats/self-identification.ts` lets a protected answer answer only an identity question (how the candidate identifies, whether the candidate is something, a self-identification, EEO, or disclosure question, or a bare category label), never one with interest, joining, membership, employee resource group, community, association, experience, working-with, language, speaking, markets, outreach, or skills wording; the LGBTQ "consider yourself a member of the … community" shape is the one exception; veteran classifications left empty take the same veto.
Regressions: "protected answers answer only identity questions (Track 82, round 2, fictional answers)" in `testing-harness/browser-worker/self-identification.test.ts`.

Round 3: the round-2 recheck found that round 2's word list still let ten non-identity wordings through ("Are you part of a Hispanic student group?", "Are you affiliated with a veterans group?", "Are you a veteran-owned business?", "Are you comfortable with Hispanic customers?", and six more), and that plural "veterans" and "disabilities" wordings were not `eeo` questions.
Fix: `isIdentityQuestion` now requires the question a label asks, without its list hints, to be in full one of a fixed set of anchored identity shapes (a bare category, "What is your …", "Are you <the category>", "Do you have a disability?", and a few standard EEO wordings); only list-hint parentheticals such as "(mark all that apply)" are stripped, so "(veteran-owned business)" keeps a label from being an identity question.
Veteran classifications are left empty only on their exact labels ("Disabled Veteran", "Newly Separated Veteran Discharge Date Month"), and `field-roles.ts` and question memory's sensitive words now cover "veterans" and "disabilities".
Regressions: "protected answers answer only identity questions (Track 82, rounds 2–3, fictional answers)" in `testing-harness/browser-worker/self-identification.test.ts` and "never saves sensitive questions" in `testing-harness/domain/question-answer-memory.test.ts`.

fixture: captured 2026-11-28 (Ashby checkbox-group markup from run <run id>'s stop evidence; option lists from held runs' pauses)
fixture: modelled (veteran classification checkboxes' required state; Ashby's click handling of its icon-covered box)

Resolved once a pass after `pnpm pipeline:retry --held` fills these on live Ashby, Lever, Greenhouse, Workday and INL forms.

## Refuted causes
- The candidate's self-identification answers were never saved. Evidence: key-presence read of the real profile on 2026-11-28: all six eeo_* keys and pronouns are current, global, source user, reuse auto.
- Ashby's checkbox lists were read without their options. Evidence: pauses of runs <run id> and <run id> record every option; run <run id>'s stop evidence shows the group's field id is its first box's name ("She/her").
- A banned-word list plus identity cues ("are you", "identif") keeps protected answers to identity questions. Evidence: round-2 recheck, ten non-identity probes matched (e.g. "Are you a veteran-owned business?").
