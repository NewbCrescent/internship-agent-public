# SmartRecruiters one-click application fields are not read

Found 2026-11-27 in Track 70's triage of the "No application form was found at <site>" stops.
LLNL (<run id>) on 2026-11-27 04:11 UTC reached SmartRecruiters' one-click application (/oneclick-ui/company/<company>/publication/<id>) with no DataDome (stop capture 2026-11-27T04-11-18-165Z-job-no-form).
The page showed "Easy Apply", Personal information, Experience, Education, Your Profiles, Resume, Message to the Hiring Team, and a Next button, all drawn as SmartRecruiters `spl-*` web components (`spl-input`, `spl-phone-field`, `spl-autocomplete`, `spl-dropzone`, `spl-textarea`).
The agent read no field and stopped "No application form was found … It may sit behind an Apply button".
Next step: a SmartRecruiters one-click adapter that reads those components (their inputs are not in the light DOM the capture shows), with a fixture from a capture of the components' inner markup; smartrecruiters stays in ATS_KINDS_NEEDING_APPROVAL.
Related: smartrecruiters-application-pages-show-datadome-to-the-agents-browser.md.

## Refuted causes

- LLNL's 2026-11-27 stop was DataDome. Evidence: stop capture 2026-11-27T04-11-18-165Z-job-no-form shows the one-click form's sections and no challenge.
