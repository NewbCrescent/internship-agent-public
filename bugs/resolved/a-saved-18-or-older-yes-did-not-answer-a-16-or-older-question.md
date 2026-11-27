# A saved 18-or-older Yes did not answer a 16-or-older question

Lockheed Martin's "Are you 16 years or older?" (a text box on earlier runs, a Yes/No list later) waited for the candidate on 15 runs between 2026-11-25 and 2026-11-26 (14 cancelled, 1 still held), although the candidate's saved 18-or-older Yes answers it.
Cause: the question mapper knew only the 18 threshold, so the question was unmapped, and the AI pause review may not answer from a fact the mapper does not name.
Fixed in Track 57: a storable catalog fact `age_16_or_older` (global, standard, user-saved like `age_18_or_older`), a mapper rule for inclusive 16-or-older wordings ("over 16", "older than 16", and a question naming both ages are not mapped to it), and a resolve-time rule in `resolveCandidateQuestion` that answers the thresholds one way only: a saved 18-or-older Yes answers a 16-or-older question and a saved 16-or-older No answers an 18-or-older question, each fill naming the saved fact it came from, while an 18-or-older No or a 16-or-older Yes answers nothing else and a question's own saved answer comes first (`packages/domain/src/candidate-facts.ts`, `packages/agent/src/question-mapper.ts`, `packages/agent/src/candidate-service.ts`; docs/technical/10-candidate-memory-policy/010).
Regression: the Track 57 cases in `pnpm test:agent` (mapping) and `pnpm test:memory` (the one-way rule).
Read-only replay (2026-11-26): on Track 57's code all 15 stored pauses resolve to Yes from the saved 18-or-older fact, and the dry run `pnpm questions:recheck --profile real` answers the held run's question (kind `saved_fact`).

fixture: captured 2026-11-26 (the stored pause labels, field kinds, and options of the Lockheed Martin runs, replayed read-only; the test fixtures are synthetic)
