# Postings behind an Apply link stopped with no form found

The 2026-11-20 07:00Z timer pass stopped the first postings from the new
posting sources with "No application form was found at <url>. It may sit
behind an Apply button": Example Capital Group's "2027 Agentic Engineering
Intern" (Jobvite), Mapwise Technologies' "Software Engineer Intern" and "Data
Science Intern" (iCIMS), and Example Consultants' "AI/ML Engineer Intern"
(iCIMS). Each page was a posting with an Apply link, not the form. Now a
page with no form has its own Apply entry followed once (`chooseApplyEntry`:
the same site, the same company domain, or a known ATS host; never "Apply
with LinkedIn", Indeed, sharing, referral, or another site; never on
Handshake), and the run reads the form there and saves that address.
iCIMS's Apply lands on an email-first account step and Jobvite's on a
data-consent step: both stop the run with a plain reason before anything is
typed (automatic runs are held, candidate-started ones end with the message;
the agent creates no account and gives no consent), and Jobvite and iCIMS are
recognized for display with the candidate approving each run. Regressions:
`ats-classification.test.ts` (kinds, `chooseApplyEntry`,
`applicationWallReason`), `run-lifecycle.integration.test.ts` ("posting
pages behind an Apply link"), and the Apply-link scenarios of
`pnpm test:browser:greenhouse`.
