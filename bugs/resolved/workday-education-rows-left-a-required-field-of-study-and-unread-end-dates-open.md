# Workday education rows left a required Field of Study and unread end dates open

Found 2026-11-25 on the real workspace, in manual pass 8. On Activision
(<run id>) Workday answered Save and Continue with "Field of Study ...
is required" on the high-school row, for which nothing is saved; on
Rockwell (<run id>) neither education date was found by its label on the
college row or the high-school row, so both paused with "no to date
field this run recognizes", although the end years are saved and were
filled on other tenants (Rockwell's markup was not captured). Education
dates are now found by their labels (more wordings: "Year graduated",
"Date completed", "Degree received" and the like) or by Workday's
`formField-firstYearAttended` / `formField-lastYearAttended` containers;
a row with no end-date field asks nothing (Workday's own check decides),
and a date field neither read pauses naming its label. A required Field
of Study on a row with nothing saved for it pauses as that row's
question before the step is saved, and the answer is used on the next
continue (`packages/browser/src/ats/workday-history.ts`). Regression:
the `?fos=required`, `?edudates=ids` and `?edudates=none` scenarios of
`testing-harness/browser/fixture-run.ts`. Open: the high-school row's
field of study is a candidate question; Rockwell's real date labels are
unknown.
