# iCIMS privacy-notice acknowledgments were held as unknown consent

Found 2026-11-25 on the real workspace. iCIMS held
careers-viasat.icims.com (<run id>) with "the email step asks you to agree
to "Acknowledgement Received"" and us-careers-rivian.icims.com (<run id>)
with "I confirm I have read the Candidate Data Privacy Notice linked
below." as `consent-unknown`. Two causes: Viasat's legal text ("I
acknowledge I have reviewed and understand the Viasat Applicant Privacy
Notice.") sits in a container beside the box's row, ending in an empty
paragraph, so only the label was read as the statement; and the iCIMS step
decided every box with the data-consent setting alone, never the
candidate's standing attestation setting, which covers privacy-notice
acknowledgments. Fix: the statement is read from the box's own block (its
highest ancestor in the form holding no other control, at most 600
characters) without screen-reader-only descriptions; the step decides with
both standing settings, logs "Accepted attestation: '<statement>' (iCIMS
<step> at <host>)", and a box that needs the attestation setting while it
is off holds as `attestation-setting`, released once the setting is on.
Regressions: the attestation cases in
`testing-harness/browser-worker/account-consent.integration.test.ts`
(`pnpm test:browser-worker:local`), the `attestation-setting` hold case in
`testing-harness/agent/icims-account.test.ts`
(`pnpm test:agent:icims-account`), and the `ack` and `blank` scenarios in
`testing-harness/browser/account-consent-run.ts`
(`xvfb-run -a pnpm test:browser:account-consent`). Not changed: the
stored Viasat and Rivian holds stay until cleared with
`pnpm icims:account --profile real --site <host> --clear-hold` after this
fix is merged; hq-lifeway.icims.com stays held, since its box says only "I
accept" beside empty legal text (iCIMS's hidden screen-reader text is not
read as its statement), and neither setting was widened.
