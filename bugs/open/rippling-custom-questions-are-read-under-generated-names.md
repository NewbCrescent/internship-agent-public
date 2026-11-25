# Rippling custom questions are read under generated names

On 2026-11-25 Rippling applications (Forterra run <run id>, APEX Analytix run
<run id>) recorded their custom questions field-94, field-98, field-102, and
field-124 under their input `name`, a random token that changes on every
load, and field-128 as "Unlabeled textarea control 17", so the question text
was never read and each paused without its question. The wrapping-label fix
(`bugs/resolved/uploads-labelled-through-their-wrapping-label-read-unlabeled.md`)
covers them if Rippling wraps these questions like its uploads, which is
assumed but not confirmed. The Pronouns box (field-24) typed the saved answer
with no matching suggestion; the ARIA list reading from Track 35 may fix it if
its list shows options on opening. Confirming needs a read-only capture of a
Rippling application with custom questions, which Track 35's clearance did not
allow.
