# Generic sponsorship and authorization questions ignored the posting's country

Glowpath (<run id>: "Will you now or in the future require sponsorship for
employment visa status (e.g. F-1 STEM OPT, H-1B, TN, E-3…)"), Tidewave
(<run id>: "Will you require future sponsorship?", "Are you legally
authorized to work in the location of this job?"), and Orbitline
(<run id>: "We are unable to provide sponsorship for this position. Will you
require sponsorship for this internship?") paused as AMBIGUOUS: the mapper
read a country only from the question. Now authorization and sponsorship
questions take the question's own country, else the posting's one stated
country; a posting with no country or several still pauses. Regressions:
`question-mapper.test.ts`.
