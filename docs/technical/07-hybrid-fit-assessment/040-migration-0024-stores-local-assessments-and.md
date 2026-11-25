Migration 0024 stores local assessments and input versions.
Migration 0025 distinguishes version-2 failures from legacy extraction failures so they cannot block the new algorithm.
Migration 0028 adds the application intent table (its triggers bump the context version) and bumps the context version once for the intent, level, and selectivity prompt (2026-11-19), so every fit scored by the earlier prompt is stale everywhere (cache, the Jobs/Review join, failure backoff) and is re-scored, at most 25 per pass; a future prompt change bumps the context version the same way.
Migration 0031 adds the coursework table (its triggers bump the context version) and bumps the context version once for the course-evidence prompt sentence (2026-11-19).
Migration 0034 (2026-11-25) narrows the three `candidate_facts` triggers to the facts the fit prompt reads, `FIT_CONTEXT_FACT_KEYS` in packages/domain `matching.ts` (today only `graduation_date`, the expected graduation in `candidateContext.level`), and does not bump the version itself; saving, revising, or revoking any other fact (work authorization, sponsorship, `how_heard`, willingness answers, attestations, voluntary self-identification answers) leaves AI fits current.
When the fit starts reading another fact, add its key to the constant and, in a new migration, to those triggers: the match-persistence suite fails when the builder reads a key outside the list, and the db suite fails when the triggers and the list differ.
Changing `INTERNSHIP_AGENT_TARGET_TERM` does not by itself re-score fits.
Academic/profile/preference/resume/claim/coursework/intent changes and fit-relevant fact changes invalidate context; requirement and snapshot revisions also invalidate caches.
Changed inputs during a call discard the response.
Version-1 capability coverage caches are stale and excluded from competitiveness ranking.
Jobs and Review Queue sort only by current AI scores; unassessed jobs follow assessed jobs.
Keyword estimates remain secondary detail and the existing deterministic pipeline fallback when no current AI judgment exists.
Automatic model failures retry after 24 hours or changed inputs; explicit Analyze fit with AI is available.
A response the citation validator rejects is repaired up to twice from the named defects — every attempt passes the same strict validator — before it counts as a failure.
Pipeline passes attempt at most 25 uncached, nonterminal, non-skipped postings in addition to discovery's new postings.
