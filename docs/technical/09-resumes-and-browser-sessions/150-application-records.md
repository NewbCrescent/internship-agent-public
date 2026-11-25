**Application records.**
After a confirmed submission (the candidate's approval or the auto-submit policy; both go through `submitBrowserRun`), `packages/agent/src/application-record.ts` writes `<profile data dir>/applications/<job>/application-record.pdf` atomically with mode 600.
It holds the company, role, posting URL, application URL, site type, submission time, who approved it (the candidate, or the auto-submit policy with its basis text; never both), the profile used (default, or the transcript alternate) with that profile's current graduation answer and the graduation date answered on the form, every form field as submitted (label, value, source; uploads named, fields left blank listed), each uploaded file with its SHA-256, the confirmation text, and the posting snapshot (first 100,000 characters).
The profile shown is the run's recorded `applicationProfile` (default or transcript, as the company's graduation-profile lock chose it; migration 0029), read through `profileOfRun`, so runs recorded before that migration fall back to their decisions; its graduation date is the matching saved answer.
The record is rendered with `renderHtmlToPdf`; the attached resume and transcript are appended as pages with pdf-lib 1.17.1 (`appendPdfPages`) when they are readable and match the recorded checksum, otherwise referenced by name and SHA-256.
A printed resume variant's checksum is of the file on disk when the record was made; a transcript moved to a `documents.removed-*` folder is still found.
Form labels are captured at submission into `submitted-field-labels.json` (mode 600) so regenerated records keep them; records for runs submitted before this change reconstruct labels from each answer's source and mark them in italics.
Writing a record is best-effort and never changes the submission; the timeline logs "Application record saved locally." or "Application record not saved; run pnpm application:record --job <id>."
(never a path or an error).
Manual check-offs get no record at check-off.
`pnpm application:record [--profile real|demo] [--job <id>] [--all-submitted]` (re)writes records for submitted applications under the pipeline lock: no flags writes only missing records; manual check-offs get an honest record saying the agent did not fill the form.
It is a manifest benchmark entry that no gate runs.
The Discord pass notice only says "Record saved locally." under a sent item; it never reads, attaches, or sends the record.
