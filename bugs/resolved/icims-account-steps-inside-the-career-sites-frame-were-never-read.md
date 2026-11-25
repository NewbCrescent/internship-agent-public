# iCIMS account steps inside the career site's frame were never read

The 2026-11-21 retry pass stopped six iCIMS runs (General Dynamics Mission
Systems, IDEMIA, BISSELL, Example Consultants, Mapwise Technologies; Garmin as
evidence only) with "the account step stopped (a page the agent does not
recognize)". The `icims-account` evidence showed the email step in the
screenshot while the top document's text held only the career-site wrapper:
iCIMS draws the account screens in a same-host `icims_content_iframe`
(`?in_iframe=1`), and `packages/browser/src/ats/icims-account.ts` inspected
only the top document, so nothing was typed. Now the screens are read and
driven in that frame (never one on another host), and CAPTCHA detection
covers it. Regression: the framed scenarios of
`pnpm test:browser:account-consent`. The hosts' stored `unexpected` holds must
be cleared (`pnpm icims:account --site <host> --clear-hold`) before a pass
retries them; the multi-page application behind the account step is still the
open "iCIMS applications stop after the account step" entry.
