# Oracle one-page form fields the agent could fill paused

The four Oracle runs that reached their forms on 2026-11-27 (pass 28:
Vertiv, Corvane x2, Idaho National Laboratory) paused on fields the profile
answers:

- Email Address: `<input id="email-45" type="email" readonly>`, already
  filled by the email step (with an "Edit email address" button); the
  planner's fill waited for an editable box and timed out ("the field did
  not respond in time") on all four.
- Phone "Country code": a `cx-select-input` combobox whose options read
  "+1 (United States)", "+93 (Afghanistan)", "+1 (American Samoa)" …; the
  profile country "United States of America" matched none
  (`countryKey("+1 (United States)")` kept the parentheses, and neither
  `dialCodeOption` nor `matchSuggestion` knew the form).
- Corvane's "Address Line 1", a type-ahead with no suggestions: "no
  suggestion matched".
- Vertiv's "First/Given Name (Please enter with letters a-z, …)" and
  "Last/Family Name (Please …)", and Corvane's "State Abbreviation", were not
  read as profile fields.

Fix (Track 63): `fillField` keeps a read-only box that already shows the
wanted value and pauses at once on one that shows another
(`handshake-executor.ts`); `countryKey` drops parentheses around the country
and `dialCodeOption` and `matchSuggestion` accept "+1 (United States)" for
any US spelling, never a territory (`autofill-planner.ts`); a street-address
type-ahead that showed no suggestion at all keeps the typed saved address,
while one that offered unmatched suggestions still pauses; the contact
labels read "First/Given" and "Last/Family", a trailing "(Please …)"
instruction is ignored, and "State Abbreviation" takes the region's
two-letter USPS code (a region that is no US state is not its answer).

Regressions: `pnpm test:browser:oracle-apply` scenario (7) (read-only email
kept, "+1 (United States)" chosen, Address Line 1 kept, no pauses) and
`pnpm test:browser-worker:fast` (the option and label rules); each fails on
the old code.

fixture: captured 2026-11-27 (markup and option texts from INL's stop capture and trace; list behaviour modelled)

## Refuted causes

- The email box was hidden. Evidence: INL capture email-45 is shown with readonly and the email step's value.
