# Oracle address lists and self-identification lists still pause

On the one-page Oracle forms reached on 2026-11-27 (pass 28), these fields
still pause after Track 63:

- ZIP, City, and County are geography lists whose options combine places
  ("<ZIP>, Berkeley, <county>, CA" for ZIP, "Berkeley, <county>, CA" for City,
  "<county>, CA" for County), with at most 500 shown; the planner matches
  none of them to the profile's postal code or city, and County is not a
  saved fact.
- On Corvane and Vertiv the gender and veteran lists were recorded as text
  fields, so the saved self-identification answers were not offered to them.
- INL's statement-of-fact screening questions correctly wait for the
  candidate.

No fix yet: how Oracle's geography lists filter when typed and why the
self-identification lists were read as text were not captured. Next step: a
redacted stop capture of each list (Track 42 saves one on the first stop of
each kind) on a requeued run, then a matcher for the combined place options
with a fixture shaped from it.

fixture: none

## Refuted causes

- Oracle's geography and self-identification lists show no options when opened, so nothing can be matched. Evidence: run trace <run id> (2026-11-27) opened ZIP Code, City, County, and the gender list while reading the form, and each listbox showed its options (500 for ZIP Code, "Female" and "Male" for gender); the gaps are in matching those options, and in the lists recorded as text on Corvane and Vertiv, which that run did not show.
