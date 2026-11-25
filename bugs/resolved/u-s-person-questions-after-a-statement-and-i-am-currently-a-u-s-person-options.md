# U.S. person questions after a statement, and "I am currently a U.S. Person" options, were not answered

Found 2026-11-25 on the real workspace, in manual pass 5. Apex's "You must
be a U.S. Person because this position requires access to information that
is subject to U.S export controls. Are you a US Person? (Citizen, Green
Card holder, etc.)" (<run id>, a Yes/No radio) and Neros's export
compliance list (<run id>, options "I am currently a "U.S. Person"", "I
will soon become a "U.S. Person" …" and "I am not a "U.S. Person," but I am
eligible for licensing …") paused "The saved answer is not among the
options". Cause: a question that does not start with a yes/no word was read
as a choice of the saved export-control status, which a Yes/No radio does
not offer; and the status matched only options naming a category
(citizen, permanent resident, refugee, asylee, protected individual,
none). An embedded "Are you a U.S. person?" sentence now maps to the
derived U.S.-person Yes/No answer, and a saved status naming a U.S.-person
category picks the one option saying the candidate is a U.S. person now; a
saved "none" status, two such options, and "will soon become" or "not …
but eligible" options never answer. Regressions: the U.S.-person cases in
`testing-harness/agent/question-mapper.test.ts` (`pnpm test:agent`) and
`testing-harness/domain/standard-answers.test.ts` (`pnpm test:domain`).
Not verified live: both postings' forms after the change.
