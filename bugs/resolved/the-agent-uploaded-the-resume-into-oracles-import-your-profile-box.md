# The agent uploaded the resume into Oracle's Import your profile box

Idaho National Laboratory run <run id> and Vertiv run <run id> on
2026-11-27 (pass 28) decided `ia-control-1=upload` for Oracle Candidate
Experience's "Import your profile from resume" box
(`div.apply-flow-block--profile-import … input.apply-flow-profile-import-awli__file-upload`,
in Stantec's stop capture). In the INL trace the import upload happened
first, the page said "Profile successfully imported.", and every later
lookup by id failed (`addressLine1-48`, `region2-52`: count 0): Oracle parsed
the resume into the form and redrew it with new id counters. Vertiv's
"Upload Resume" then "did not respond in time".

Fix (Track 63, `packages/browser/src/handshake-executor.ts`
`collectControlsIn`): a file input inside `.apply-flow-block--profile-import`
or `.apply-flow-profile-import` is not a control, beside Ashby's and Dover's
"Autofill from resume" exclusions; the resume goes only into the form's own
upload.

Regression: `pnpm test:browser:oracle-apply` scenario (7) (the import box
gets no file, the form's own fields keep their ids and values); fails on the
old code, where the import redraw renamed every field.

fixture: captured 2026-11-27 (the block's markup from Stantec's stop capture; the redraw modelled from INL's trace)

## Refuted causes

- The ids changed because the page was reloaded. Evidence: INL trace <run id> shows one navigation; the id lookups fail right after the import upload and the "Profile successfully imported." alert.
