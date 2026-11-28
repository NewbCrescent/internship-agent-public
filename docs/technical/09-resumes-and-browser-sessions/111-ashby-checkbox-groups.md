**Ashby checkbox groups (Track 82, 2026-11-28).**
Ashby names each box of a checkbox group after its own option ("She/her", "He/him"), so no box name is the question's, and a group whose boxes carry different names takes a `data-ia-control` tag as its id (`collectControlsIn`, packages/browser `src/handshake-executor.ts`); a group whose boxes share one name keeps that name.
Its option is checked by role and name inside the tagged group, and a box that refuses the click (Ashby's box sits under an icon) is checked through its own `label[for]`; a box that is still unchecked is reported as "the site did not keep the choice".
Before, the group took its first box's name as its id, so only the first option could be found and every other option failed with "the option was not found".
The regression is `pnpm test:browser:ashby-demographics` (`testing-harness/browser/fixtures/ashby-demographics.html`, the markup shape captured from a held run's stop evidence).
