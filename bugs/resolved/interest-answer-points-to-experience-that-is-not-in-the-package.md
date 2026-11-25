# Interest answer points to experience that is not in the package

With no allowed evidence claims, `buildAnswers` still writes "names <stack>,
which matches work described below." although no "most relevant experience"
answer follows, plus a double space before "names". Seen in the Example Co
package prepared on 2026-09-22 (`packages/writer/src/package-builder.ts`).
The sentence is presentation text, so the verifier cannot catch it.

Fixed: the sentence cites described experience only when a relevant-experience
answer exists, without the stray space. Regression: `mentions described
experience only when the package describes some` in
`testing-harness/writer/package-builder.test.ts`.
