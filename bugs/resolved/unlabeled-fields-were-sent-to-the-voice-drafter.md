# Unlabeled fields were sent to the voice drafter

Corvane (<run id>) paused on "Unlabeled textarea control 2", and every
paused textarea was offered to the voice drafter, which would write prose
for a question nobody could read. Now a field with the recognizer's
"Unlabeled … control N" label is never drafted. The label itself is still
open (see Open). Regressions: `voice.test.ts`.
