# Ashby submits left no record of what was sent

An Ashby submit's evidence held only the page's text and screenshot, so a
silent page (<run id>, <run id>) could not say whether the submit was sent
or what Ashby answered. Unproven explanations: H2, Ashby's server answered
with a FormRender naming the missing field but "Your form needs corrections"
was not drawn within 30 s; H3, reCAPTCHA Enterprise's token step hung or
failed, so the submit mutation was never sent; H4, a reCAPTCHA score
rejection (`RECAPTCHA_SCORE_BELOW_THRESHOLD`) whose failure container was
not drawn; H5, a server or network error with no visible message; H6, the
click never reached Ashby's handler (no token request and no submit). Now
the agent records Ashby's submit on the network from before the first click
(`packages/browser/src/ats/ashby-network.ts`): Ashby's GraphQL operation
names and HTTP statuses, the submit's token kind, result type, success,
error codes and messages, field errors, and block message, and each
reCAPTCHA token request; bodies are read in memory only and never kept.
Ashby's answer decides the outcome: `FormSubmitSuccess` confirms, a
`FormRender` naming fields pauses them with the approval withdrawn, the
block message is refused, and a reCAPTCHA rejection is held as challenged,
never retried, and refused by `--reopen-unsubmitted`. Once a submit request
went out after a click the agent never clicks again. The record is kept in
evidence.json (`ashbyNetwork`) and printed by `pnpm run:evidence`. Real runs
<run id> and <run id> stay failed; nothing is applied to the real records.
Regressions: the `?network=` scenarios in `pnpm test:browser:greenhouse`,
the network tests in `pnpm test:browser-worker:fast`,
`pnpm test:agent:evidence`, and `pnpm test:agent:retry`.
