# "Have you read the privacy policy?" lists were held although the option consents

Found 2026-11-25 on the real workspace, in pass 13. Littelfuse's "Have you
read the Littelfuse Privacy Policy?" list (littelfuse.wd1, run <run id>),
offering "Yes, I have read and consent to the Global Privacy Policy" and
"No", paused although the candidate's standing data-consent setting covers
privacy-policy consent given as a condition of applying. Cause: the
standing classifier read only the label, a question that consents to
nothing by itself; the consent is in the option. Fix: a list or radio set
whose label asks whether the candidate read a privacy policy or notice
(`isPrivacyReadQuestion`) is decided on the question and its one affirmative
option together ("<question> — <option>", `privacyReadStatement` in
`packages/domain/src/standing-consent.ts`), like any statement, in
`standingFieldDecision` (`packages/browser/src/standing-fields.ts`): an
option that also consents is privacy-policy consent under the data-consent
setting, a bare "Yes" is a privacy-notice acknowledgment under the
attestation setting, a fact or marketing option vetoes, and a clipped label
never counts. The decision's basis and the timeline entry carry that
combined exact text. Regression: the privacy-read cases in
`testing-harness/domain/standing-consent.test.ts` (`pnpm test:domain`) and
`testing-harness/browser-worker/standing-consent.test.ts` (`pnpm
test:browser-worker:fast`). Not verified live: the run was not retried in
this change.
