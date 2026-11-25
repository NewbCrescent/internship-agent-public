`candidate_coursework` (migration 0031) holds the candidate's relevant courses: one school plus, per course, its code, title, term, and status (`completed` or `in_progress`), in the candidate's order, with provenance "candidate-confirmed from transcript" (`source = 'candidate_confirmed_transcript'`).
It is written only with `pnpm profile:coursework`, from a list the candidate gives; courses are never inferred.
It holds no grades and no student ID, and the transcript file itself is never parsed.
Its triggers bump the AI-fit context version (0024), so a changed set re-scores every AI fit.
