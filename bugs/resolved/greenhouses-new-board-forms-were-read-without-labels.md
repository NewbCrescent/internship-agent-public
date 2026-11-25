# Greenhouse's new board forms were read without labels

The same pass held Greenhouse runs (<run id>, <run id>, <run id> on tidewave,
<run id> on ironvaleindustries, which redirects to job-boards.greenhouse.io)
with "Unlabeled input control N" questions, two "Attach" fields that needed a
document, and "How did you hear" options (LinkedIn, Glassdoor, Indeed,
Referred by a friend) as separate questions. The generic reader ignored
aria-labelledby, so react-select lists were plain text inputs and their
hidden required inputs became unlabeled controls; the file inputs' own labels
say "Attach" (the group's label says "Resume/CV" or "Cover Letter"), and the
filler located every field by label, so both uploads would hit the first;
each checkbox of a fieldset was its own field. Now labels come from
aria-labelledby first, an "Attach" upload takes its group's label, fields are
located by id, react-select lists are one select with their options and the
hidden inputs are skipped, a checkbox fieldset is one question (the
How-did-you-hear group answered from the saved `how_heard` rule), and Discord
notices sum up any unlabeled fields in one line. Regressions:
`pnpm test:browser:greenhouse`, `recognition-planner.test.ts`, and
`testing-harness/agent/discord-notify.test.ts`.
