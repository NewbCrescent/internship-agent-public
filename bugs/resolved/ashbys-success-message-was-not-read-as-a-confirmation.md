# Ashby's success message was not read as a confirmation

Lumora's Ashby run (<run id>) ended failed with "no confirmation text was
recognized": Ashby replaces the form with its success container
(`.ashby-application-form-success-container`, role=status), whose message can
be the employer's own wording with no usual confirmation phrase. Now that
container counts as a confirmation when it appears after the submit click,
and "Thanks for applying" and "Your application has been submitted" are
confirmation phrases; nothing recognized still fails closed. The Lumora run
stays failed and is not marked submitted: the candidate checks the
application on the site. Regressions: `recognition-planner.test.ts` and the
Ashby confirmation scenarios of `pnpm test:browser:greenhouse` (default
message, custom message, none).
