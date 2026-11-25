# The displayed fit silently falls back to the keyword estimate

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
