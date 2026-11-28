# Bare Mailing, Home, Permanent, and Current Address labels paused

Track 84 found read-only on 2026-11-28 that the contact labels in `packages/browser/src/autofill-planner.ts` map the street line only for "Address", "Street Address", "Address Line 1", "Home Address Line 1", and "(Home|Mailing|Permanent) Street Address".
A bare "Permanent Address", "Mailing Address", "Home Address", or "Current Address" box paused, and a single box asking for the whole address on one line was never composed from the saved address.
Track 83, round 2 added `addressDecision`: an address asked whole ("Full address", "Address (City, State, Zip)", or a text area labelled "Address" or a prefixed address) gets the profile address on one line only when street, city, state, and ZIP are all saved, and a bare prefixed address text box gets the street line only when the form also asks the city or ZIP.
The stop re-check plans one field alone, so a bare "Mailing Address" stop stays paused there by design.
Regression: `pnpm test:agent` (`testing-harness/agent/held-question-corpus-track83.test.ts`, address rows).
Open until a live run confirms it: a read-only search of the real database on 2026-11-28 found no held run with a bare prefixed label (only "Home Address Line 1", which the existing rule covers).
The whole-address text area shape is captured: Strada Education Foundation <run id> Q2 ("Address", a text area), which the read-only replay of 2026-11-28 now answers from the profile (profile_field).

fixture: modelled
