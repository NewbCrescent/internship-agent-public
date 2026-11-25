# Workday postings outside the US were read without a country

Example Consulting's "Data & AI Consultant - INTERNSHIP - Milano" (employer-b.wd3) was not
recognized as non-US: "Location: no country is stated". Discovery passed only
Workday's `location` ("Milan"), and the extractor deliberately never reads a
bare city as a country. Now the posting's own country descriptor joins a
single location ("Location: Milan, Italy"); multi-location values are kept as
is. Postings stored before the fix keep their old snapshot. Regression:
`testing-harness/jobs/github-list-source.test.ts`.
