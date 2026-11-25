# Paylocity applications span five steps

A Paylocity Recruiting application (`recruiting.paylocity.com/Recruiting/Jobs/Apply/<id>`,
captured read-only on 2026-11-24) is a form of five steps: the first page
shows "Step 1 of 5", the identity, address, and LinkedIn questions, and a
"Next Step" button, and no submit control. The agent now recognizes the kind
(`paylocity`), reaches that page from the posting (closing the accept-only
cookie banner), and stops the run there with the several-page reason before
anything is typed, since filling only the first page would leave the run
stuck at submit. No success text was found in the site's own scripts. Next
step: a capture of the later steps (questions, EEO, review, submit, and the
confirmation) from a session the candidate opens, then a Paylocity walker
with a disposable-Chromium regression; until then `paylocity` stays in
`ATS_KINDS_NEEDING_APPROVAL`.
