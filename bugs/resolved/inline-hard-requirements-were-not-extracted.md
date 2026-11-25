# Inline hard requirements were not extracted

The bounded real-source recheck reanalyzed 27 postings and left one Greenhouse
posting with zero requirements. Its description states “Proficiency with
Python is required” inside a paragraph, not a bullet. Before the candidate
enabled a graduate-internship exclusion, all five extracted hard PhD
requirements produced `NEEDS_REVIEW` verdicts. The saved preference now
excludes graduate-only roles; the posting that explicitly allows a B.S.
alternative remains for candidate review.

Fixed: deterministic extraction recognizes applicant-directed prose sentences
with their own explicit requirement cue and preserves their exact spans. A
guarded repository operation replaces requirement rows only for the expected
current snapshot and only before application preparation. Regressions:
`extracts explicit inline requirements without treating general prose as
requirements` and `repairs only grounded requirements on the expected non-live
snapshot` in the jobs harness. The one affected real Example Trading posting was
repaired from its existing snapshot on 2026-09-23: it now has the stated hard
Python requirement and a `NEEDS_REVIEW` verdict. Its snapshot stayed unchanged,
and no current Greenhouse/Lever posting has zero extracted requirements.
