# Failed requirement classification silently kept rule labels stamped as model labels

The live pass of 2026-11-19 logged "Requirement classification fell back to
deterministic rules: fetch failed" once and "...: The model exhausted its
output budget before returning JSON; lower the batch size or raise
maxOutputTokens." many times, yet the real workspace showed every
`job_requirements` row as `MODEL` (718) and none as `DETERMINISTIC`. The
classifier's catch returned the rule label for every line of a failed batch,
and because a decision existed for each index, ingestion stamped those rows
`MODEL`; ingestion also silently kept the rule label for any line the model
left unlabelled. Decisions (eligibility, preparation, automatic runs) could
therefore rest on rule labels. Now a model classifier returns a model label
for every line or the posting is held (`requirement_label_holds`, migration
0027) with no requirement rows, not analyzed, prepared, or run, and retried on
each pipeline pass; the provider retries network errors, 500/502, and 429/503,
and the classifier sends `reasoning_effort: "medium"`, splits batches on budget
overruns, bad or incomplete answers, and timeouts, and retries single lines at
doubled budgets. Automatic runs refuse any posting with a rule-labelled
requirement. `pnpm labels:hold-fallback --apply` marks postings labelled
before the fix for relabelling. Regression:
`testing-harness/agent/requirement-labels.integration.test.ts`
(`pnpm test:agent:labels`), with the rule-label and hold gates in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts`.
