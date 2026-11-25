# MITRE's Country Phone Code was not read as the phone country

On MITRE run <run id> (2026-11-26) the Phenom apply form reached its personal-information step and paused only on "Country Phone Code", a native select of country names with "USA" as the United States entry.
Its label matched no contact label (the phone country pattern knew "Country code", "Phone country code", and "Country dialing code"), so the profile country was never used.
Fix: "Country Phone Code" is read as the profile country (`CONTACT_LABELS`, `packages/browser/src/autofill-planner.ts`), and a US profile takes "USA", never "U.S. Virgin Islands" or "United States Minor Outlying Islands" (`matchCountryOption`).
Regressions: scenario (g) of `pnpm test:browser:unrecognized-forms` (`fixtures/phenom-application.html`, reduced from a read-only capture of 2026-11-25) and the phone-code case in `pnpm test:browser-worker:fast`.
