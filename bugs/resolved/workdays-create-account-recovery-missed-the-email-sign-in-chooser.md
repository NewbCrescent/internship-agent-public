# Workday's create-account recovery missed the email sign-in chooser

Raytheon's saved page showed the email sign-in chooser after a create timeout.
The adapter supported that chooser on entry but did not handle it when the
create form's Sign In link opened it. The recovery now recognizes the chooser
on the expected Workday host and selects email once. The account service also
preserves the create timeout's request and page transition diagnostics in the
follow-up hold or timeline event. The Chromium fixture covers the chooser
transition and the diagnostics in an interrupted hold. Raytheon's saved
evidence did not include the chooser's DOM marker or establish the cause of
the live create timeout.
