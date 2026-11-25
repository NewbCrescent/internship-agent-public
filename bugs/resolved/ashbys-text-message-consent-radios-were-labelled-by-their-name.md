# Ashby's text-message consent radios were labelled by their name

The 2026-11-24 runs of two Illumio postings (Ashby) paused on a radio set whose
only label was `communicationConsent`, its name attribute. Ashby draws its
text-message consent inside the phone field's entry, in
`.ashby-application-form-texting-consent-description`, with no fieldset,
legend, or label for the question, and the nearby-question walk stopped at the
phone input; the radios also took the phone's required mark. No code applied
the candidate's text rule either: the standing settings count every text
opt-in as marketing. Now the radios take the consent text ("Check Yes or No to
indicate your agreement to receive text message updates from … regarding your
job application …"), a fieldset checkbox group with no legend takes its
question title, and the candidate's rule (2026-11-20, "Texts yes about my
application status") answers texts about this application Yes and marketing or
job-alert texts No, and pauses a mixed or unclear question with its label
(`textMessageTopic`, `textMessageConsentDecision`). Regressions: the Ashby
texting-consent scenario of `pnpm test:browser:greenhouse`
(`fixtures/ashby-texting-consent.html`) and the text-message cases of
`pnpm test:domain` and `pnpm test:browser-worker:fast`. The paused runs keep
their stored pause; a fresh run applies the rule.

This closes the open entries "Ashby's text-message consent is read without
its question" and "Application-status text consent is not implemented"
(2026-11-24). As that second entry noted, the rule is not one of the two
standing settings in AGENTS.md: it is the candidate's own rule, applied in
code like the how-did-you-hear rule, and it never accepts marketing.
