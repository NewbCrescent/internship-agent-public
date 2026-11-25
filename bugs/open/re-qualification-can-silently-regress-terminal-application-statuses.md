# Re-qualification can silently regress terminal application statuses

`evaluateAndPersistMatch` derives the posting status from the fresh verdict
without consulting the current status or writing an `application_events` row.
On 2026-10-07 a bulk re-qualification moved a Sep 23 AI-submitted posting
(`<run id>`, submitted with confirmation) back to `ANALYZING` with no event,
and a later prepare pass returned it to `READY_FOR_REVIEW`; the status was
restored to `SUBMITTED` with an explanatory event, and the one-off rematch
script now skips `SUBMITTED`/`APPROVED`/`APPLYING`. The orchestrator itself
still has no guard, so any future broad re-match can repeat the regression.
Fix direction: refuse to move terminal or in-flight statuses backwards (or at
least record the transition as an event).
