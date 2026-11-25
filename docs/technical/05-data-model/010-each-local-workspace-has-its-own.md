Each local workspace has its own SQLite file and one candidate ID.
The existing `data/internship-agent.sqlite` is the fictional demo; `data/profiles/real/internship-agent.sqlite` holds the real profile and its jobs, evidence, applications, and outcome history.
The browser stores only the validated `real` or `demo` selector in a local HTTP-only cookie, defaults to real, and passes the selected database explicitly through every page and action.
`candidates` stores that workspace's editable profile.
`candidate_preferences` stores typed role, location, work-mode, and graduate-internship exclusion preferences; those values never imply an application answer.
The exclusion is disabled by default and stored independently in each workspace (migration `0016_graduate_internship_preference.sql`).
