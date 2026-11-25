# Job-level holds could not be requeued, and Ashby's review text outranked its network record

Found 2026-11-25 on the real workspace, after Track 28 fixed Workday
entry. Eight Workday jobs (PTC <run id>, National Interstate <run id>,
Jabil <run id>, Compassion <run id>, Example Brands <run id>,
NVIDIA <run id>, KLA <run id>, Granite Dynamics <run id>) stayed READY_FOR_REVIEW
behind "Automatic browser run needs you: No Workday application opened
at …" with a manager-owned job-level `automation-fault` hold and no run
that is not cancelled, because the stop came before any run was saved.
`pnpm pipeline:retry --verified-hold` takes only `--run` ("no browser run
matches"), and `--held` looks only at runs. Separately, `--reopen-unsubmitted`
refused Apex Technology's failed Ashby submit (<run id>) as "failure or
correction text": the page's autofill banner "Please review the information
we filled in for you below" matched the text heuristic although the
capture's Track 22 network record shows no submit request was sent. Fix:
`pnpm pipeline:retry --job <ref> --verified-hold --revision <n> --recheck
<ref> --reason …` (`requeueVerifiedJobHold`) releases one manager-owned
job-level automation fault at the exact revision, on a job with no run
that is not cancelled and no submit ever attempted, logging "Automatic run
retried after a fix: <reason>" and recording the recheck; that note now
counts as the job's newest hold source, so a refresh does not reopen the
hold (`packages/agent/src/automatic-retry.ts`,
`packages/agent/src/application-holds.ts`). In `judgeSubmitCapture` an
Ashby network record with no submit request skips the failure-text check;
every other check and the fresh receipt-check gate stay
(`packages/agent/src/unsubmitted-evidence.ts`). Regression: the
`verified job-level hold requeue (--job)` and review-boilerplate cases in
`testing-harness/agent/automatic-retry.integration.test.ts` (`pnpm
test:agent:retry`). Open: Illumio's <run id> and <run id> captures have no
network record, so their GDPR acknowledgment text ("please review the
points below") still refuses them.
