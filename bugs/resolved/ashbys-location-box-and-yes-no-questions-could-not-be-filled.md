# Ashby's location box and Yes/No questions could not be filled

Fernwave Sciences (<run id>) still paused on "Location" and on "Are you legally
authorized to work in the country this role is located in?". The captured
page's location input has no id and no name, so recognition gave it a
synthetic id the executor could not find; its required star is the question
title's `_required` class; Yes/No questions are button pairs over a hidden
checkbox, read as a checkbox that was ticked or skipped. Now a control with
neither id nor name is tagged `data-ia-control` (stable across
recognitions) and located by it, `_required` titles mark a question required,
Yes/No pairs are one radio question answered by clicking the button (kept
only when the button shows pressed), location suggestion rows are read, and a
fieldset's question title labels its radios. Fernwave's "…office and involves
working primarily in person. Are you willing and able to work from this
location?" now carries its real label (it read "Yes") and pauses: a plain
"Yes" would claim no relocation is needed. Regressions:
`recognition-planner.test.ts` (`recognizeFields` ref) and the Ashby scenario
of `pnpm test:browser:greenhouse`.
