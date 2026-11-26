`job_requirements`, `job_technologies`, `job_locations`, `job_compensation`, and `job_constraints` each carry a character span into the current snapshot.
Ingestion re-verifies every span against the snapshot text and drops any that does not match, so a stored field always quotes text the posting actually contains.
Public board HTML conversion preserves list items as bullet lines before normalization.
Deterministic extraction reads those bullets and also applicant-directed prose sentences with their own explicit hard or preferred cue; general prose and section headings alone do not become requirements.
A guarded requirement repair can replace only requirement rows for the expected current snapshot while a posting is still in a pre-preparation status; it verifies every replacement against the stored text and leaves the snapshot and other derived rows unchanged.
For a hard Master's- or doctorate-only requirement, subject overlap with an undergraduate degree does not establish eligibility: the match needs candidate review unless recorded degree evidence establishes the required level.
When the candidate enables graduate-internship exclusion, matching fails internships or co-ops with an explicitly Master's/PhD-targeted title (one that also names a bachelor's level, such as "BS/MS/PhD", is not) or a stated hard graduate-degree requirement lacking an explicit bachelor's alternative.
Preferred graduate study and unrelated prose mentions do not trigger this preference.
The match reason identifies it as a saved preference, not a candidate fact.
