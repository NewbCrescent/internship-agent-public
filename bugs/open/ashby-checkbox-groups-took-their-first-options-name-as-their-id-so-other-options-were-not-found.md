# Ashby checkbox groups took their first option's name as their id, so other options were not found

Held runs paused with "the option was not found" on Ashby multi-choice questions: Abridge <run id> (pronouns, sexual orientation, ethnicity), Sierra <run id>, Strava <run id> and <run id>, and Base Power Company <run id> ("How did you hear …").
Their stored field ids are the first option's text ("She/her", "Bisexual", "Base Power Company website").
Cause: Ashby names each checkbox by its own option value, and `collectControlsIn` set a checkbox group's id to `group.id || boxes[0].name`; `chooseOption` then searched `input[type=checkbox][name=<first option>]`, which only ever holds the first option, so any other option was not found.
Fix (Track 83, fixed with Track 82 (docs 111)): a group's id is its element id, else the one name all its boxes share, else the group's `data-ia-control` tag (Track 82), else `checkbox-group-<n>`; the group and each box are tagged, and a group with neither an element id nor a shared name is found by its tag, or, after Ashby redraws the form and drops every tag, again by its label (one field with that label), its one named option checked through its own label and read back within 2 s (`packages/browser/src/handshake-executor.ts`, `checkGroupOption`).
Regression: `pnpm test:browser:greenhouse` (the Ashby value-select scenario checks "Git", not the first option "ROS").
fixture: modelled (the markup of `testing-harness/browser/fixtures/ashby-value-select.html` is derived from Ashby's public bundle; the stored field ids of the real held runs confirm the naming).
Stays open until a live Ashby run checks an option other than the first.
