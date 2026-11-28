# Self-identification questions still held applications after Track 82

Found 2026-11-28 (held-question survey after Track 82; the candidate's saved self-identification answers and pronouns were present).
Run ids are the held runs' first eight characters; no saved value, and no per-run outcome that would imply one, is recorded here.

Causes:
1. Oracle's "Veteran Self-Identification Status" list (INL <run id> and <run id>) was not an identity shape, so it paused as a sensitive question.
2. Oracle's "Active Duty Wartime or Campaign Badge Veterans" box (INL <run id> and <run id>, Corvane <run id>) is plural, so it missed the exact veteran-classification labels and paused.
3. Greenhouse's long disability question, "Do you have a disability or chronic condition (physical, visual, auditory, cognitive, mental, emotional, or other) that substantially limits one or more of your major life activities, including mobility, communication (seeing, hearing, speaking), and learning?" (EQT <run id>, ParetoHealth <run id>, SharkNinja <run id> and <run id>, Veeam <run id>), was not an identity shape.
4. Oracle's single "I am Hispanic or Latino." box (INL <run id> and <run id>, Corvane <run id>) had no rule: it is neither a list nor a "mark all that apply" group.
5. Lever's demographic survey on Hermeus (<run id> and <run id>, both run with Track 82's code) opens with "What is your location?" over a list of every country and shows its questions only once a country is chosen; the planner left that optional list empty, so the ethnicity boxes stayed hidden and the fill stopped with "the option was not found" (stop evidence 2026-11-28T08-16-40-543Z: the box is marked hidden and the survey's ethnicity options are absent from the page text).

Fix (Track 90): `packages/browser/src/ats/self-identification.ts` adds "veteran self-identification status" to the bare categories, the long disability question as one exact identity shape, the plural "Veterans" to the veteran-classification labels, and `hispanicCheckboxChoice` (checked for a saved Hispanic or Latino answer, left empty when optional for any other saved race or ethnicity answer, with one reason for both); `packages/agent/src/browser-orchestrator.ts` resolves the box and `packages/browser/src/autofill-planner.ts` plans it; `surveyCountryDecision` in `autofill-planner.ts` answers "What is your location?" asked over a country list of at least 50 options with the profile address's country.
Regressions: "self-identification questions still held after Track 82 (Track 90, fictional answers)" in `testing-harness/browser-worker/self-identification.test.ts` (with the closest non-identity wordings, which still pause) and the Oracle Hispanic box, veteran status list, and plural classification box test in `self-identification.integration.test.ts`.

Not fixed here:
- "Are you a veteran or active member of the United States Armed Forces?" (the five Greenhouse runs above) stays held: whether the candidate serves now is not saved.
- Littelfuse <run id>'s Workday ethnicity checkboxes are still read with no options (as <run id> was in Track 82); a capture of that list is needed first.
- Corvane <run id>'s gender and veteran status lists are still read as text (bugs/open/oracle-address-lists-and-self-identification-lists-still-pause.md).
- ParetoHealth <run id>'s "Do you attest to the following statement? … is an equal opportunity employer …" is a clipped attestation, not a self-identification question.
- Held runs from before Track 82 (Lockheed Martin <run id> and <run id>, Sierra <run id>, Strava <run id> and <run id>, Tinder <run id> and <run id>, Toyota Research <run id> and <run id>) were never planned again with Track 82's code.

The stop re-check skips sensitive pauses, so the held runs pick these fixes up through `pnpm pipeline:retry --held`.

fixture: modelled (Oracle's Hispanic box and plural classification box as single checkboxes, their required state, and Lever's survey revealing its questions once a country is chosen; labels and option lists from the held runs' pauses and stop evidence of 2026-11-28)

Resolved once a pass after `pnpm pipeline:retry --held` fills these on live Oracle, Greenhouse, and Lever forms.

## Refuted causes
- The held INL, Corvane, Hermeus, and Greenhouse runs predate Track 82. Evidence: runs <run id>, <run id>, <run id>, <run id>, <run id>, <run id>, <run id>, <run id>, <run id>, and <run id> were created after Track 82's merge (2026-11-28T07:52Z), and the Track 82 code replayed over their pauses settles none of causes 1–4.
- Lever's ethnicity boxes are not found because each box carries its own name. Evidence: stop evidence of run <run id> shows the boxes share one name (`surveysResponses[…][field1]`), the case the executor's shared-name path handles; the box was hidden.
