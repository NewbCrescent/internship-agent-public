# Workday's My Experience resume upload labelled "Upload a file" was not attached

Found 2026-11-25 on the real workspace, in manual pass 5. My Experience on
littelfuse.wd1 (<run id>) and zoll.wd5 (<run id>) paused on
"`formField-`": "Upload a file (5MB max)" asks for a document the agent
does not upload. Cause: the resume input sat inside a Workday `formField-`
container with an empty suffix, so the collector read it with that
container's generic label; the fallback that names the upload "Resume/CV"
runs only when no upload was read, and a required upload with a generic
label is a document the candidate attaches. On My Experience, the one
upload whose label is generic upload wording ("Upload a file", "Attach
files", "Drop files here or select", with or without a size hint) is now
the resume upload: it is relabelled "Resume/CV", receives the resume, and
a resume already attached is replaced, as for Workday's usual input. Two
generic uploads, a named document (cover letter, transcript), another
step, or a step that already has a resume upload are left as read.
Regression: the `markWorkdayResumeUpload` cases in
`testing-harness/browser-worker/workday.test.ts` (`pnpm
test:browser-worker:fast`) and the `?gaps=1` scenario of
`testing-harness/browser/fixture-run.ts` (`xvfb-run -a pnpm
test:browser:fixture`). Not verified live: the tenants' markup (no
form-step DOM was captured; the fixture's upload is modeled on the pause
record).
