# A prefilled phone country picker was retyped and cleared

On Lockheed Martin run <run id> (2026-11-26) Eightfold's "Country code picker" already showed "🇺🇸 (+1) United States of America", but its list could not be opened while the welcome dialog covered the page, so it was read as a type-ahead and planned to type "United States".
Typing first cleared the country it showed, and the search found no suggestion ("no suggestion matched "United States"").
Fix: a country field that already shows the profile's country is kept, never retyped; a leading flag and a leading dialing code are ignored when countries are compared (`countryKey`, `packages/browser/src/autofill-planner.ts`), and a picker showing another country is chosen to the profile's.
A bare "+1" names no country, so a picker that shows only a dialing code is still chosen.
Regressions: scenarios (d) and (f) of `pnpm test:browser:unrecognized-forms` and the kept-picker case in `pnpm test:browser-worker:fast`.
