# Workday's education Add Another and Degree clicks were covered

Found 2026-11-25 on the real workspace, in manual pass 8. Sierra Space
and Micron stopped on Education's Add Another, and Rockwell and enGen on
the second row's Degree, with a 30 s click timeout: the element was
found, visible, enabled and stable, and another element took the click
point. The recorded detail is cut before Playwright names that element,
so the cover is inferred: a list the filler left open (Workday's
multi-select Field of Study list stays open after a pick) or the typed
school's suggestion layer. Before each Add, Delete, or dropdown click in
a history row the adapter now closes any list still open, and a click
not taken within 5 s falls back to focusing the control and pressing
Enter (`clickWorkdayControl` in
`packages/browser/src/ats/workday-lists.ts`, also used for every Workday
dropdown); nothing is force-clicked. Regression: the `?widgets=real`
scenario of `testing-harness/browser/fixture-run.ts` (an open Field of
Study list over Add Another) and `?widgets=real&school=text` (a
suggestion layer over Degree). Not verified live.
