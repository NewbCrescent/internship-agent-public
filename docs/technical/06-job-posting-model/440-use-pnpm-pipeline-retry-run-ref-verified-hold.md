Use `pnpm pipeline:retry --run <ref> --verified-hold --revision <n> --recheck <hex-ref> --reason "<reason>"` for one manager-owned pre-submit automation fault after an independent passing recheck.
The command records the supplied recheck reference and under the pipeline lock verifies the current revision, current evidence and existing retry eligibility.
The cancellation, requeue and trace commit together.
Add `--dry-run` to inspect eligibility without writing.
This mode rejects bulk, immediate startup, Workday host release and any run that may already have submitted.
The normal pipeline worker applies its existing fit, cap and approval checks when it next takes the job.
