# Radio choice lookup disagreed with the option label read from the form

Starwood's Jobvite work authorization and sponsorship choices reopened with
“the option was not found” after the run tried to apply the answers. The
Jobvite Chromium fixture reproduces that error when a radio's visible label
differs from its accessible name. The browser now selects named radios by the
same labels it reads from their group and refuses duplicate matches. The
fixture verifies both successful selections and the duplicate-label hold.
