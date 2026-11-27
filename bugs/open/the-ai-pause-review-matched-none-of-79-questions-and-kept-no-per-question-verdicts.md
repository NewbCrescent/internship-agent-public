# The AI pause review matched none of 79 questions and kept no per-question verdicts

On the real profile's pass 23 (2026-11-26, 12:32–12:55Z), 22 timeline events read "AI review looked at N open question(s): 0 matched saved answers, …": 79 questions were reviewed, none was matched, one draft was suggested, and `candidate_question_aliases` held no rows.
The review kept only that summary line, so which verdict the model gave each question, and which guardrail refused a match, could be read only from the note the review adds to each pause.
Track 54 reconstructed the batches read-only: node:sqlite queries opened with `readOnly: true` on the real database, and the project's own mapper, fact-group, never-reuse, posting-context, and saved-answers code run over the stored runs.
No model replay was needed, because `applyPauseReview` adds the model's reason (needs_candidate) or "AI review suggested a saved answer, but it did not pass the checks (<check>)" to every reviewed pause's question.
On the latest run of each of the 22 reviewed jobs, the 79 questions split into 74 needs_candidate verdicts (or drafts not kept, which leave the same note), 4 saved_answer verdicts refused by guardrails, and 1 kept draft (Capital Technology Group's "Why are you interested…").
The 4 refusals were all on Coinbase's work-history block ("Start date month" and "End date month": no matching option; "Start date year" and "End date year": field kind), where the model matched a previous job's dates to the availability dates; the refusals were correct.
No question was refused by the "mapped question", "option disagrees", "sensitive answer", "scope", "statement of fact", or "never reused" checks.
The model gave needs_candidate for every question the mapper maps in those batches (Lockheed Martin's active security clearance, Xona's export control, Coinbase's full-time start, Veeva's relocation questions, Danaher's former employment, and several ambiguous ones).

Causes for the five questions the brief named:
- Capital Technology Group, "Are you a current college student majoring in computer science or related field?" and "Please provide a link to your LinkedIn profile.": neither was in any reviewed batch. They are open only on run <run id> (job <run id>), held since 2026-11-24T21:22Z, before Track 45, which pass 23 neither started nor continued; job <run id> has no AI review event. On the reviewed Capital Technology Group run <run id> (job <run id>) today's planner answers both from the profile (basis `profile`), and the stop re-check ignores answers taken from the profile: see `the-stop-recheck-ignores-answers-the-planner-takes-from-the-profile.md`.
- OpenSesame, "Do you currently require or will you need sponsorship for employment visa status now or in the future?" (job <run id>, run <run id>): the posting's only place is "Remote" with no country, so the mapper returns AMBIGUOUS, and sponsorship is a sensitive, country-scoped fact saved only for named countries. No saved answer applies to a posting with no country; this is the scope rule working.
- CodeRabbit, "Are you an undergrad, masters or PhD student from <a named university>?" (job <run id>): unmapped, and the model said needs_candidate. The answer depends on the profile's school, which is a profile field, not a catalog fact; the review never sends it by design and its guardrails fill only catalog facts.
- Compassion, "Type of employment desired" (job <run id>, a Workday checkbox list): unmapped, and nothing saved covers it; preferences are not application answers, so the candidate answers it.

Fixed in Track 54: every reviewed question now gets one timeline line, `AI review of "<label>" (q<n>): <verdict>; <outcome>.`, naming the model's verdict, the fact key when it is one of the keys sent, the refusing check, and for a "mapped question" refusal the mapper's result, never a value (`packages/agent/src/pause-review.ts`; docs/technical/10-candidate-memory-policy/117).
The mapper-status rule is not relaxed: when the mapper maps a question and the deterministic resolver finds no saved answer, the hold comes from its scope, narrowing, or former-employer rules, and letting the model fill it would widen the scope or move the question to another fact; no reviewed question in pass 23 needed it.
Regression: the Track 54 case in `pnpm test:agent:pause-review:local` (a mapped-but-unresolved match stays refused with the mapper named, an option disagreement and a sensitive answer are refused, and the per-question lines carry no values).

fixture: modelled (a fake model provider; the next live pass with a configured model confirms the per-question lines)

Follow-ups, done in Track 57:
- A deterministic planner rule comparing a university a question names with the profile's school: `bugs/resolved/a-question-naming-a-university-was-not-compared-with-the-profile-school.md`.
- A deterministic rule that a saved 18-or-older Yes answers a 16-or-older question (Lockheed Martin's "Are you 16 years or older?" was unmapped and waited): `bugs/resolved/a-saved-18-or-older-yes-did-not-answer-a-16-or-older-question.md`.
- A prompt hint that fields of a past job or education entry are not availability dates: `bugs/open/the-ai-pause-review-prompt-did-not-say-past-dates-are-not-availability.md`.

## Refuted causes

- (a) The mapper-status rule (`status !== "UNMAPPED"`) refused the model's saved-answer matches. Evidence: the AI-review notes on the 79 reviewed pauses of pass 23 (latest runs of the 22 reviewed jobs, 2026-11-26 12:32–12:55Z) show no "mapped question" refusal; the model gave needs_candidate for every mapped question.
- (a) An option-matcher disagreement refused a valid match. Evidence: no "option disagrees" note; the two "no matching option" refusals were Coinbase's previous-job "Start date month" and "End date month" fields, which the availability dates do not answer.
- (a) A sensitivity, scope, statement-of-fact, or never-reuse guardrail refused a valid match. Evidence: none of those checks appears in the 79 notes.
- (b) The saved-answers list left out the fact for the two Capital Technology Group questions. Evidence: neither question was in any reviewed batch (run <run id> has no AI review event); today's planner fills both from the profile on run <run id>.
- (b) The saved-answers list left out sponsorship. Evidence: requires_sponsorship (country:US, as "saved") was sent; the OpenSesame posting is Remote with no country, so no saved scope applies and the mapper returns AMBIGUOUS.
- (c) The model said needs_candidate although a saved fact answers the question exactly. Evidence: for the three of the five that were reviewed (OpenSesame, CodeRabbit, Compassion), no current reusable catalog fact answers the question as asked in this posting's scope.
