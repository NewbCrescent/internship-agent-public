`job_constraints` holds one row per stated constraint only.
A posting that does not mention sponsorship has no sponsorship row, which is not the same as sponsorship being unavailable.
A constraint's text (`raw`, at most `STATED_CONSTRAINT_MAX_LENGTH` = 600 characters) is the matched sentence; a longer "sentence" (no period or newline, such as comma-joined clauses) keeps a window of at most 600 characters from 200 before its keyword, with a span over exactly that window, while the decision (dates, country, requires or offers) is still read from the whole sentence.
Rows stored before the window have their raw text (and a span over 2,000 characters) clipped on read (`clipStatedText`), so the posting still parses and its analysis runs.
