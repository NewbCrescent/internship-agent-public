# Graduate-only requirements were ignored when the model labeled them "graduation"

Example Software's "Intern, AI Agent Evaluations" states "Currently enrolled in a MBA." The
model classified the line with subject GRADUATION, which the matcher treats
as a duplicate of the graduation-date constraint check; the posting states
no graduation window, so the line produced no finding and the job showed
65/100 needing review for unrelated skills, despite the candidate's B.A. and
their graduate-internship exclusion. "MBA" was also not recognized as
graduate study at all. The requirement's "confidence 0.90" (how sure the
reading of the line is) read as if it scored the candidate.

Fixed: degree level is read from the requirement text, not the model's
subject label (with program wording such as "enrolled" or "pursuing" so a
tool name like "MS SQL Server" is not a degree); MBA, M.Eng, M.Sc, MPH, MPP,
J.D., and law school count as graduate study; titles such as "Intern - MBA"
are covered by the exclusion; and the label now reads "reading confidence
90%". Re-analyzing 377 unprepared postings moved 7 graduate-only roles to
not qualified. Regression: `checks graduate programs like an MBA from the
requirement text` in `testing-harness/matching/eligibility-fit.test.ts`
(it rated the Example Software case QUALIFIED before the fix).
