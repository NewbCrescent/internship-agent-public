# A pause quoting the saved coursework list made a whole run fail

Real pass 33 (2026-11-27) stopped "Tinder — Backend Engineer Intern" (Lever)
with "Automatic browser run failed: [ { "origin": "string", "code": "too_big",
"maximum": 500, … "path": [ "decisions", 29, "reason" ] }, … [ "decisions", 29,
"pause", "question" ] ]", so no run was saved for the posting.

Decision 29 was the Lever question "Have you used a backend programming
language, such as Python, Java, Go, or JavaScript/TypeScript (Node.js), to
build a server-side application? Experience through coursework, personal
projects, or internships qualifies." (219 characters; a Yes / No / Not Sure
list).
The deterministic mapper reads it as `relevant_coursework` (its "Experience
through coursework" wording), whose answer is the saved coursework list
(ten courses, about 800 characters).
No offered option matched, so the planner paused with "The remembered answer
is "<answer>", which is not among the options for "<label>". How should it be
answered?" (`packages/browser/src/autofill-planner.ts`), and its
`pauseDecision` copied that unbounded question into the decision's reason.
The pause record stayed valid only because the AI review's note
(`packages/agent/src/pause-review.ts`) cut the record's question to 500
characters; the decision kept the long text and `saveBrowserRun` rejected it.

Fix (Track 72): `clipDecisionText` (`packages/domain/src/browser.ts`, with
`DECISION_TEXT_MAX` = 500, the schemas' unchanged limit) bounds a text to 500
characters with an ellipsis, and the planner's `pauseDecision` applies it to
every planner pause's question and reason in one place.
As a safety net, both run saves (`saveBrowserRun` calls in
`packages/agent/src/browser-orchestrator.ts`) pass every decision and pause
record through `boundDecisionText` / `boundPauseQuestion`, so a long reason
from any other step (a Workday walker, the attached-resume check) is shortened
rather than failing the run.
Exact accepted or signed statements are untouched: their text lives in the
standing-consent basis and its timeline line, never in the reason.

Regression: `pnpm test:browser-worker:fast` (consent-and-facts.test.ts: a
fictional 219-character Yes/No list resolved to an 800-character coursework
answer is planned with a schema-valid decision and pause record, reason and
question at most 500 characters); it fails on the old code with the same Zod
error.

fixture: modelled (the label length and answer length come from the real run's form text and saved coursework, read read-only on 2026-11-27; the test uses fictional text)

Open: mapping this yes/no experience question to `relevant_coursework` is its
own question-mapper issue and is not changed here.

## Refuted causes

- A form label longer than the 300-character limit. Evidence: recognition clips labels to 300 (`MAX_LABEL` in `packages/browser/src/form-recognition.ts`), the run's longest label was 331 characters before clipping (the run trace's body text, 2026-11-27), and the error named no pause-record label.
- An unfilled-field, voice-draft, or AI-review pause. Evidence: `unfilledPause`, `applyVoiceDrafts`, and the AI review note already cut their questions to 500 characters, and the AI review's timeline line for the field (2026-11-27T06:11:24.419Z) says verdict needs_candidate, so it did not replace the decision.
