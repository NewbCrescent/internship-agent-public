# Workday's invisible reCAPTCHA badge read as a CAPTCHA

The Workday account reader counted any visible `iframe[src*="recaptcha"]` or
`iframe[title*="captcha"]` as a CAPTCHA, so the invisible reCAPTCHA Enterprise
badge (titled "reCAPTCHA") would hold account creation. Now it uses
`challenge.ts`'s visible-challenge rule (the badge and the hidden token are not
a challenge) plus visible hCaptcha and Turnstile frames and Workday's robot
text. Regression: the `?markup=real` scenario of
`pnpm test:browser:workday-account`, which carries the badge.
