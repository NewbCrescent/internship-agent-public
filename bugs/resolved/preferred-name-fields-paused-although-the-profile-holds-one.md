# Preferred name fields paused although the profile holds one

Orbitline's "Preferred First Name" (<run id>) paused: no contact label
mapped it. Now "Preferred name" / "Preferred first name" fill the profile's
preferred name; with none, an optional field stays empty and a required one
pauses. It is never derived from the legal name. Regressions:
`recognition-planner.test.ts` and the Greenhouse scenario of
`pnpm test:browser:greenhouse`.
