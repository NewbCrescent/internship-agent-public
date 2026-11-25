The configured `MODEL_API_*` provider automatically judges overall competitiveness from the full normalized description after discovery and during `advancePipeline`.
It no longer requires extracted SKILL/EXPERIENCE rows.
Inputs include approved non-archived resume entries, ALLOWED + CURRENT claims, and candidate-entered academic profile fields (school, degree, field, graduation date, GPA).
Each saved course (`candidate_coursework`) is also a citable evidence item `course:<CODE>` (code upper-cased, spaces as hyphens; text: code and title, school, term, and status, with an in-progress course labelled "in progress (not yet completed)"; no grades), appended after the existing at most 80 items so courses never displace them; the prompt tells the model an in-progress course is current study, never completed coursework.
Names, contacts, legal facts, credentials, browser state and student IDs are excluded; textual identifiers and credential patterns are redacted.
The input also carries a non-citable `candidateContext` (`fitCandidateContext`): the candidate's application intent (`candidate_application_intent`, migration 0028; set with `pnpm fit:intent --set "<statement>"`, shown with `pnpm fit:intent`, removed with `pnpm fit:intent --clear`; redacted like other text) and their level (school, degree, field, expected graduation from the global `graduation_date` fact or else the profile, the target term from `INTERNSHIP_AGENT_TARGET_TERM`, and the school years left after it, derived from the graduation date by `termStanding`).
The intent states preferences only; it is never evidence, a citation, or an application answer.
Documented example statement: "CS student graduating in 2028, looking for a Summer 2027 software engineering or adjacent internship (SWE, ML, data or infra engineering).
I'd rather apply to any role I'm a realistic candidate for than only sure bets.
Skip roles that need experience or degrees I don't have, or that aren't really engineering."
Descriptions over 60,000 characters are rejected rather than silently truncated.
The candidate explicitly approved this automatic model assessment.
The existing provider, rate limiter and invocation ledger use `job.semantic_fit`; page reads never call a model.
