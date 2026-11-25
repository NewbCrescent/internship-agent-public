# Oracle Digital Assistant's chatbot box was read as an Oracle question

Corvane's Oracle runs (<run id>, <run id>, 2026-11-20) paused on field
`oda-work-summary-text-area|input`, labelled "Discard" and later "Unlabeled
textarea control 2". It is not an application question: Oracle's public
Candidate Experience bundle draws it as the required work-summary box of
Oracle Digital Assistant's chatbot popup (`oda-summary`,
`<oj-text-area id="oda-work-summary-text-area">`), and the read-only capture
of 2026-11-24 found it on the email step's page. Now `collectControlsIn`
never reads a control inside an `oda-` element or `.oda-chat-wrapper` on an
Oracle Cloud host. Regression: the chatbot scenario of
`pnpm test:browser:oracle-apply` (fails on the old code).
