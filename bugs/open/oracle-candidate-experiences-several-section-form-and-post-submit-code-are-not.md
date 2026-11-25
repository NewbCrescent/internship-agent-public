# Oracle Candidate Experience's several-section form and post-submit code are not handled

The agent now takes Oracle Cloud HCM Candidate Experience's email step and its
emailed one-time code (see Resolved), but what follows is not handled yet, so
`oracle` stays in `ATS_KINDS_NEEDING_APPROVAL`. No adapter walks Oracle's
several-section form (`/apply/section/<n>`, Next per section, Submit only on
the last): a single-section form is filled by the generic filler, and a
section showing Next stops the run with the several-page reason. A new
candidate meets Oracle's code step only after Submit (`/apply/confirm`), and
the post-submit security-code lookup reads only Greenhouse's mail and its
hold texts say Greenhouse; a successful submit lands on `/my-profile`, which
is not read as a confirmation. Oracle's field ids carry counters
(`primary-email-0`, `-1`), so a continue or submit may not find the saved
fields and fail closed. The PIN, section, and confirmation screens and their
English strings, and the code email itself, were never seen (derived from
Oracle's public Candidate Experience bundle). Next step: a capture of a
section page from a session the candidate opens, then a section walker and
the post-submit code step and confirmation (after Track 10's submit-outcome
work merges), each with a disposable-Chromium regression.
