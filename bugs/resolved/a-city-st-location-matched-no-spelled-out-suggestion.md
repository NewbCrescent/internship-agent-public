# A City, ST location matched no spelled-out suggestion

Orbitline's "Location (City)" (<run id>) and Fernwave Sciences' Ashby
"Location" (<run id>) paused: the profile's city and state abbreviation (for example
"Springfield, IL") matched no suggestion that spells the state out
("Springfield, Illinois, United States"). Now a US state's code and
name stand for each other in `matchSuggestion` (still exactly one match,
never a guess), and a "City, Region" value with no match is searched again by
the city alone. Regressions: `recognition-planner.test.ts` and the Greenhouse,
Ashby, and Lever scenarios of `pnpm test:browser:greenhouse` (fixture profile
region "CA").
