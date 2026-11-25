`outcome_events` stores candidate-recorded response, OA, screen, interview, final, offer, rejection, and ghosted stages beside the broad job status.
The migration copies earlier interview, offer, and rejection status events into the detailed ledger.
Ghosted is a recorded observation, not an irreversible job status.
`model_invocations` carries an optional source URL for calls made before a job row exists and an optional micro-USD cost snapshot.
Cost is unknown unless both user-supplied per-million-token rates are configured; older calls stay unknown.
Cost per submitted application, interview, and offer uses the cost of all recorded model calls, including work on jobs that never reached submission; any call with unknown cost makes the unit costs unknown.
Analytics never changes preferences automatically.
