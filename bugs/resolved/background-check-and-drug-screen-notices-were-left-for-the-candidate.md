# Background-check and drug-screen notices were left for the candidate

Found 2026-11-25 on the real workspace, in pass 10. On littelfuse.wd1
(<run id>) two required lists offering "Select One", "Acknowledged" and
"Not acknowledged" paused: "Subject to applicable federal and/or state
law, you will be required at some point in the process to submit to a
criminal background check, employment verification, and education
verification. …" and "… you will be required post interview process to
submit to a post-offer drug screen." Neither states a fact about the
candidate; each acknowledges a background-check or drug-test
requirement, which `INTERNSHIP_AGENT_SIGN_ATTESTATIONS` covers. Cause:
the whitelist's authorization phrasing needed a verb such as "I
authorize" or "I consent to". `classifyStandingStatement` now also counts
a statement that the process will require submitting to a background
check, employment or education verification, or a drug screen as such an
authorization when it asks no question; under the attestation setting
its one affirmative option ("Acknowledged") is chosen and the exact text
logged on the timeline (`packages/domain/src/standing-consent.ts`).
Regression: the new cases in `testing-harness/domain/standing-consent.test.ts`
(`pnpm test:domain`) and `testing-harness/browser-worker/standing-consent.test.ts`
(`pnpm test:browser-worker:fast`).
