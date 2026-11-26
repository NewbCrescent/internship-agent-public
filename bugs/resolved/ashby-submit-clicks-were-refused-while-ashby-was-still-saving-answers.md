# Ashby submit clicks were refused while Ashby was still saving answers

Every Ashby submit the agent made ended without a confirmation: Lumora
(<run id>) and Brightlane (<run id>) on 2026-11-20, First Resonance
(<run id>, <run id>) on 2026-11-23, and Contoro Robotics (<run id>,
continued-run sweep) on 2026-11-25 00:41Z. Thirty seconds after the click
each page showed the filled form and an enabled Submit Application button,
with no success, error, or field message. Ashby's public bundle (read
2026-11-24) saves each answer to its server as it is set and, while a save
is running, answers a submit click with "We're updating your application
(e.g. uploading files), please try again when they're finished.", sending
nothing; the notice goes when the save ends. The agent clicked Submit
straight after its last fill and upload, so every click was refused. It was
not Ashby's invisible reCAPTCHA Enterprise spam check: that refusal leaves
a lasting "We couldn't submit your application" container. Now on Ashby
the agent blurs the focused field and waits 2 s before the click, watches
for that notice and clicks again (at most three clicks) once it has gone,
fails closed when the last click still meets it, holds Ashby's spam-check
failure as challenged and any other failure container as refused (never
clicked again), and no longer counts a closed dialog (Ashby's type-ahead
list or cookie banner) as a confirmation. Contoro <run id> stays failed
and is not reopened automatically: no command reopens it today; the
candidate checks the Contoro application on the site. Regressions: the
Ashby answer-save and failure scenarios of `pnpm test:browser:greenhouse`
(`?saving=`, `?failure=` in `fixtures/ashby-application.html`) and the
Ashby submit-feedback tests in `recognition-planner.test.ts`
(`pnpm test:browser-worker:fast`).

## Refuted causes

- Ashby's busy notice (a submit click refused while an answer save was still running) as why the submits ended unconfirmed, this file's own cause (Track 16). Evidence: the First Resonance <run id> and Contoro <run id> records of 2026-11-25 08:4xZ (Track 22's network record) show no reCAPTCHA token request and no submit after the click, the only Ashby call being an answer save made before it, and the busy notice never appeared in those captures (their detail is empty); the clicks went to the autofill pane's "Upload file" button (Track 27, `ashby-submit-clicks-went-to-the-upload-file-button.md`).
- Ashby's invisible reCAPTCHA Enterprise spam check. Evidence: that refusal leaves a lasting "We couldn't submit your application" container (Ashby's public bundle, read 2026-11-24), and thirty seconds after each click the pages showed no success, error, or field message.
