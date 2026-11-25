# Greenhouse's phone country never kept its choice

On Greenhouse's new boards (runs <run id> Ironvale, <run id> Glowpath,
<run id> Orbitline, <run id> Tidewave) the contact "Country" paused. The
phone-country list shows only the chosen dialing code ("+1") once
"United States +1" is picked, so the executor's check that the list shows the
option failed and the field came back unfilled; a profile country spelled
"US" or "USA" also matched no "United States +1" option. Now a shown dialing
code that ends the chosen option counts as kept, and Country options match
across the United States' spellings and a trailing dialing code (exactly one
match, else a pause). Regressions: `recognition-planner.test.ts`
(`matchCountryOption`) and the Greenhouse scenario of
`pnpm test:browser:greenhouse` (the fixture shows "+1").
