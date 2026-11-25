# Long accuracy certifications on Workday text boxes are read clipped

Found 2026-11-25 on the real workspace, in pass 10. On neogen.wd5
(<run id>) the run paused on a required multi-line text box (not a
checkbox) under "I verify that the information given by me in this
application is true, accurate and complete. I understand that if I have
given false information …". Form recognition keeps 300 characters of a
label (`MAX_LABEL` in `packages/browser/src/form-recognition.ts`, the
`browserFieldSchema` label limit), so the label was read clipped ("…")
and the rest, where any request to type a name would be, was not
recorded. A clipped statement is never accepted and the visible part
names no signature, so the box waits for the candidate. Next step: keep
the full label for statement classification (a recognition and schema
change) so a real run shows what the box asks.
