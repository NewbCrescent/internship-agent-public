# An export-control list asking for work authorization status was read as work authorization

Muon Space's Greenhouse question "U.S. Export Control laws require that access … be limited to U.S. Persons (U.S. Citizens and Lawful Permanent Residents/Green Card Holders) … Please indicate your current Immigration and Work Authorization status." (options "US Citizen", "Lawful Permanent Resident", "Protected Person", "None") was the only open question on runs <run id> and <run id>, held as "saved fact not used: authorized_to_work" (pass 25 blocker b0f34511bf3).
Cause: the question mapper's work-authorization rule matched "work authorization" before the standard mapper, which maps the export-control status list to `us_person_export_controls`, ran; a Yes/No work authorization cannot pick a status option, and must not.
Fixed in Track 57: a question naming export control (or ITAR, or U.S. persons) that also asks for work authorization or eligibility goes to the standard mapper first, and only its MAPPED result is used, so the candidate's own saved export-control status decides it; an AMBIGUOUS or unmapped standard result keeps the work-authorization mapping, and plain citizen-or-authorized questions are unchanged (`packages/agent/src/question-mapper.ts`).
Regression: the Track 57 case in `pnpm test:agent` (mapping).
Read-only replay (2026-11-26, `pnpm questions:recheck --profile real`, dry run): both runs' Q1 now resolve as standard answers.

fixture: captured 2026-11-26 (the stored pause label and options of the Muon Space runs, replayed read-only; the test fixture is fictional)
