# A phone number box, a degree-program enrollment question, and a how-did-you-connect list were held

After pass 31 (2026-11-27) held runs waited on questions the candidate's
profile and saved answers already cover.

TELUS Digital on Ashby (paused <run id>; cancelled <run id> and <run id>):
"Phone" asked as an Ashby Number question (fieldKind "number"), and "Are you
currently enrolled in a degree program at a registered college or
university?" (Yes/No radios).
The planner's contact rule applied only to text, email, tel, and url boxes
and lists, so a number box never got the profile phone; and the
current-student wording `CURRENT_STUDENT` (`packages/agent/src/question-mapper.ts`)
took "enrolled in a college" but not "enrolled in a degree program at a
registered college".

Figma on Greenhouse (cancelled <run id> and <run id>): "How did you connect
with us?", a list of events, a partnership, and "Other".
`isHearAboutQuestion` did not read "connect with us" as the how-heard
question, and with no job-board option the candidate's rule would have
ended in a seeded pick that could claim an event the candidate never
attended.

Fix (Track 67): a "Phone" number box takes the profile phone's digits only
(none when they are fewer than 7 or more than 15;
`packages/browser/src/autofill-planner.ts`); `CURRENT_STUDENT` takes "in a
degree (or academic) program at a (registered or accredited) college or
university" and stays a broader question (only a saved Yes answers it);
"How did you (first) connect with us?" is the how-heard question
(`packages/browser/src/ats/hear-about.ts`), and the rule picks an option named
Other after N/A and before the seeded pick.

Read-only replay after the fix (2026-11-27, `questions:recheck --profile real`,
dry run): run <run id> (TELUS Digital) Q1 profile_field and Q2 saved_fact;
"open pauses: 274; would be answered by saved answers: 2 (saved_fact 1,
profile_field 1)".
Figma's runs were cancelled, so they are not in the replay.

Regressions: `pnpm test:browser-worker:fast` (recognition-planner.test.ts:
the phone number box, "How did you connect with us?", and the Other tier),
`pnpm test:agent` (question-mapper.test.ts: the enrollment and connect
wordings), and `pnpm test:agent:aliases:local`
(question-aliases.integration.test.ts: a held phone number box and
enrollment question matched as profile_field and saved_fact on a dry run);
each fails on the old code. The tests use fictional names.

fixture: captured 2026-11-27 (the stored labels, field kinds, and options of the held runs, replayed read-only; the tests use fictional names)

## Refuted causes

- The profile had no phone. Evidence: the real profile's phone is set (shape only, read read-only 2026-11-27), and the pause records fieldKind "number" (run <run id>), which the contact rule's TEXT_KINDS excludes.
- The enrollment fact was not saved. Evidence: enrolled_full_time (global) is true and current in candidate_facts (read read-only 2026-11-27); the wording did not match CURRENT_STUDENT.
