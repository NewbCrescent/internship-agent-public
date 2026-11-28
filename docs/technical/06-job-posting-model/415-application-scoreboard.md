**Application scoreboard.**
`pnpm pipeline:scoreboard [--profile real|demo] [--days N] [--json] [--no-save]` answers where applications get stuck and what the single biggest blocker is right now (`packages/agent/src/pipeline-scoreboard.ts`).
It opens the workspace database read-only, never reconciles holds, and never writes the database.
Its reads live in `packages/db/src/scoreboard-repository.ts`.
The funnel covers the last N UTC dates ending today (default 7, at most 90), one row per date and a total row.
Each job counts at most once per stage, on the first UTC date in the window it reached that stage, so the daily counts sum to the total.
Seen counts the distinct listing links in the discovery traces (`discovery-traces/<date>.jsonl`), on the first date each appears; a date with no trace file shows a dash.
Stored counts jobs created in the window.
Qualified counts a qualified and eligible match evaluated in the window, or a move to preparation.
QUALIFIED status changes are not logged as events, so a re-evaluation can move a job's qualified time into the window.
Ruled out counts a job whose current state is ruled out: not qualified (by its feedback skip reason, its not-qualified event, or the subjects of its failed findings, never their reason text), not pursued for the target, or held by a company cap.
Started counts the first browser run or run-start event, at submit counts a submission approval or a run that reached the submit step, and failed or held counts a started job that has a current hold.
Only confirmed submissions count: a submitted run with a recognized confirmation, or a checked employer receipt.
A plain status flip to SUBMITTED and the 2026-11-21 closed-dialog relabel ("Modal dialog closed after submit without errors") are not counted; they are reported as "marked submitted without confirmation".
The blocker board groups every currently held or paused application by its blocking cause and ranks the causes by how many applications each holds, then by how many it holds alone.
Questions group by the question-memory normalization, with the company's own name read as "the company", so different wordings of one question share a blocker.
Question labels keep their digits, so "Are you 18 or older?" and "Are you 21 or older?" are two blockers.
Stop and hold reasons group after their sites, numbers, quoted text, company name, and Playwright logs are removed.
A held run's stop reason comes only from a stop or hold event ("Automatic browser run waiting|needs you|failed|stopped: …", "Automatic submission failed: …", "Application hold: …"), never from its start, restart, or retry note; without one, a paused run whose every question is answered shows "<ATS>: all questions answered; the run waits to be continued", another paused run "<ATS>: paused with no open question", and a failed run "<ATS>: browser run failed" (Track 78).
A link at a sentence's end leaves the period in place, so the reason still ends at its first sentence.
Workday history pauses show as "<section> history entry: <field>" (for example "education history entry: degree") or "<section> history row", never with the school or employer the entry names, so the same field on different entries is one blocker.
A sensitive pause shows as "a sensitive or self-identification question", never with its label.
The kinds are a question, a missing fact, a saved fact or saved answer that was not used, a document, a field to fix in the browser, a safeguard challenge, an automation fault, a stop, a hold at the submit step, and a submit that may have gone through.
Each blocker is marked "needs the candidate" (a question or a missing fact), "needs a fix" (an automation fault or a mapping gap), or "site safeguard" (a CAPTCHA or bot check, manual only).
A blocker's id is "b" and the first 10 hex characters of the sha256 of its kind and normalized cause, so it stays the same across runs and input order.
The output holds labels, counts, and company names only: never answers, offered options, drafts, decision values, confirmation text, saved fact values, or self-identification values.
A printed label that contains a value the candidate entered (profile identity and contact fields, coursework schools, current text and protected fact values, question-memory answers, current resume entry titles and links) is withheld as "(label withheld: it contains a saved candidate value)".
A withheld blocker groups by a hash of its original text, so identical originals still share one blocker and a stable id.
The values are matched as whole words in memory only; short numbers and generic answers such as yes or no are ignored, and they are never printed, logged, or stored.
Ruled-out reason heads are checked the same way.
Labels read back from an older snapshot and claim labels and release reasons read from the claims file are checked the same way before they print.
Blockers whose labels changed this way (history entries, sensitive questions, digits) get new ids, so the first run after the change shows them as cleared and new.
Each run saves a snapshot under `<workspace data>/scoreboard/` (folder mode 700, file mode 600) unless `--no-save`, prints what grew and shrank since the previous snapshot, and prunes snapshots older than 30 days and all but the newest 200.
Every pipeline pass (`pnpm pipeline:run`, the watcher's pass, and `pipeline:retry --start`) also builds the board with the same code at its end, after the hold refresh, saves its snapshot, prunes the folder the same way, and logs one line such as `Board: 3 applications held; top blockers: <label> 2, <label> 1 (snapshot saved)` (track 61).
That line lists at most three blockers, each label cut at 80 characters, and is never sent to Discord.
A board that cannot be built logs `Board: not refreshed (<error code>); the pass is unaffected.`, and a snapshot that cannot be saved ends the line with `(snapshot not saved: <code>)`; neither fails the pass.
So the 200-snapshot cap holds about a day of passes, and "Since the last scoreboard" in a manual run compares with the last pass's snapshot.
A fix track claims a blocker with `--claim <id> --track "<track>"`, which is refused for an id that is not on the current board.
A track holds one claim at a time and renews it by claiming it again; a claim with no renewal for 24 hours shows as stale and another track may take it over.
`--release <id> --reason "<text>"` gives the claim up with a stated reason, and `--done <id>` marks it finished.
Claims live in `scoreboard/claims.json` next to the snapshots, mode 600, written under a lock; release and done history is kept for 30 days and shown for 7.
The daily digest and the pass notice are unchanged: the candidate digest deliberately hides manager-owned holds, and a scoreboard line there would show internal fault blockers to the candidate.
