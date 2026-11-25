Generated resumes are built from the candidate's structured resume entries.
`resume_entries` gives each experience, project, or skills group a stable identity, section, position, and archive flag; `resume_entry_revisions` stores every edit (title, role, link, location and date exactly as written, bullets or skill items, source, review status) and supersedes, never deletes, the previous revision.
Entries the candidate types are approved on save.
Entries transcribed from a base resume record that resume's id and checksum and stay `PENDING` until the candidate approves them; a stale revision cannot be approved.
`candidates.gpa` holds the GPA as printed on the candidate's resume.
