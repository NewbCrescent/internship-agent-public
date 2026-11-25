The demo database stays at `data/internship-agent.sqlite`; the real database is `data/profiles/real/internship-agent.sqlite`.
`INTERNSHIP_AGENT_DATA_DIR` may point to another local parent directory.
The development seed and CLI default database remain demo-only.
Browser-run files, base resumes, rendered resume PDFs, and the persistent browser profile use each profile's corresponding data directory.
Tests and browser verification override the parent directory with disposable temporary data and verify cleanup.
