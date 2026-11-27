# A city-of-residence question was not answered from the profile city

Axon <run id> Q3 "What city do you currently reside in?" (Greenhouse, a text box) waited for the candidate although the profile holds a city.
The planner fills a city box from the profile only when the whole label is a standard contact label, and the city rule knew only "City", "Town/City", and "City/Town", while the state rule already took "What state do you currently reside in?".
Fix (Track 71, `CONTACT_LABELS` in `packages/browser/src/autofill-planner.ts`): "What city do you currently reside in?", "Which city do you live in?", and "City of residence" take the profile's city, with the profile as the basis; office preferences and where-would-you-work questions still pause.
Regression: `pnpm test:browser-worker:fast` (`testing-harness/browser-worker/recognition-planner.test.ts`, Track 71 test); it fails on the old code.
Read-only replay (2026-11-27, `pnpm questions:recheck --profile real`, dry run): before the change 373 open pauses, 0 would be answered by saved answers, 69 skipped, 304 still open (296 would reach AI review); after it 139 open pauses, 0 would be answered (profile_field 0), 17 skipped, 122 still open (118 would reach AI review).
The open pauses fell between the two replays because held runs were cancelled in the meantime, Axon <run id> among them (cancelled 2026-11-27T05:46Z), so its Q3 is no longer held and the replay cannot show it; its stored pause (label "What city do you currently reside in?", field kind text) is the case the regression covers.

fixture: captured 2026-11-27 (the stored pause label and field kind of run <run id>, replayed read-only; the test fixtures are fictional)

## Refuted causes
- The profile had no city. Evidence: read-only check of the real database (2026-11-27): the profile's city is present.
- The question asks where the candidate would like to work. Evidence: the stored label of <run id> Q3 asks where the candidate currently resides.
