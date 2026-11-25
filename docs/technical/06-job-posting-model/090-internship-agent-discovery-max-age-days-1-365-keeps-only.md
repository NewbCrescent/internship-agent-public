`INTERNSHIP_AGENT_DISCOVERY_MAX_AGE_DAYS` (1–365) keeps only GitHub list rows listed within that many days (Simplify and SpeedyApply Age columns, Vansh `date_posted`); undated rows (the quant list) are skipped while it is set.
With a target term, Vansh rows labelled with another season are skipped.
Both filters run before the scan cap.
Vansh rows link through `go.vansh.nyc`; discovery reads that one redirect without following it and resolves the board link it names.
When the board states no location, the list's location column is prepended as "Job list location: …", which the extractor reads like a labelled location line.
