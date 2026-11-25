# Every file-upload field received the resume

`planAutofill` turned any file field into a resume upload, so a "Transcript",
"Cover letter", or unlabeled attachment field would have received the resume.
Confirmed by reading `packages/browser/src/autofill-planner.ts` on
2026-09-22, while adding transcript uploads.

Fixed: upload fields are routed by label (`classifyUploadRole`). Only resume or
CV fields receive the resume, only transcript fields receive the stored
transcript, and anything else pauses for the candidate. Regression:
`uploads the resume and transcript only into matching fields` in
`testing-harness/browser-worker/recognition-planner.test.ts`.
