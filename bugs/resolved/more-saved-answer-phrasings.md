# More saved-answer phrasings

Glowpath (<run id>) paused on "Do you have any immediate family that work at
Glowpath?", "What state do you currently reside in?", "Which university are
you currently attending?" (a campus-only list such as "Berkeley"), and "…
required to be in the San Francisco office. Are you ok with this
requirement?". Now "immediate family" maps to relatives_at_company, the
state-of-residence phrasings take the profile's address region (a US state
name or code matched to the other form among the options, exactly one), the
current-university phrasings take the profile school (same words, else the
one option naming only its campus, never "Other"), and "be in the <city>
office" maps to work_arrangement. Salary expectations, FDA/OIG debarment,
conflict of interest, export controls, DoD eligibility, "within 50 miles of",
and a preferred first name with no saved value still pause. Regressions:
`question-mapper.test.ts`, `recognition-planner.test.ts`, and
`application-history.test.ts` (`campusOption`).
