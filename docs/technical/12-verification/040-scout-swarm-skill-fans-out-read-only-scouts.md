The project skill `.claude/skills/scout-swarm/SKILL.md` describes a scout swarm for broad discovery over many independent targets, such as companies' job boards, sources, sites, listings, or pages.
It pays off only for more than about 8 independent targets that each need their own fetch or read; smaller or routine work stays in one session.
It is not for a single lookup, code changes, or anything that writes to real data.
The lead splits the targets into disjoint slices and starts at most 12 background scouts (default 6), each with a self-contained brief, and swarms are never nested.
Scouts are read-only: public pages only, no sign-ins, never typing into forms, stopping at CAPTCHAs, and one or two pages per target.
Each scout writes only its own file, `scratchpad/scout-<run>/<scout-n>.json`, and every claim carries a `source_url`.
The lead drops rows that fail the schema, records per-scout failures, de-duplicates by a normalized URL host and path or a company slug, and keeps each row's provenance.
An independent verifier re-fetches the source of at least 10% of the rows or 5 rows, whichever is larger, rows that fail are dropped, and below 80% agreement the whole result is flagged unreliable.
The result is one merged JSON file and a short summary, and it reaches the database or source lists only through a reviewed, dry-run-first import.
Scout briefs never carry candidate PII or secrets, and scouts honor robots rules and site terms.
