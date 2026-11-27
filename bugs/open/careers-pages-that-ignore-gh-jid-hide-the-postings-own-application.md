# Careers pages that ignore gh_jid hide the posting's own application

Found 2026-11-27 in Track 70's triage of the "No application form was found at <site> It may sit behind an Apply button" blocker (b6244893e6b).
Nintendo (<run id>, stopped 2026-11-25 00:07 UTC "No application form was found at https://careers.nintendo.com/?gh_jid=4417311009. It may sit behind an Apply button").
Read-only fetches 2026-11-27: that address serves the careers home page (the gh_jid query is ignored; no Greenhouse address in the HTML).
Greenhouse's board API lists the job open with that same address as its absolute_url, and its hosted job page redirects back there.
The posting's own page is /jobs/4417311009/ with "Apply for this role" to /jobs/application/4417311009/, a Nintendo-hosted form.
Next step (not small): reach the job's own page from the home page (a listing hop the walker does not take) or keep the Greenhouse board ingestion confirmed and open its embed; the embed rule "the board is read only from the page, never guessed" applies.

## Refuted causes

- Nintendo's page embeds a Greenhouse application the agent missed. Evidence: read-only fetch 2026-11-27 of the gh_jid address returned the home page with no Greenhouse frame, script, or address (also noted in greenhouse-applications-embedded-in-company-careers-pages-were-not-followed.md).
