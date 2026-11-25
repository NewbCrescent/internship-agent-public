`base_resumes` records candidate-supplied PDFs (channel `default` or `handshake_internal`, original name, SHA-256, size); the bytes live in `<profile data dir>/resumes/<id>.pdf` with owner-only permissions.
One row per channel is current; replacements supersede, never delete.
File-upload fields are routed by their label: a resume or CV field receives the resume, a transcript or academic-record field receives the stored transcript, and a cover letter or any other attachment stays empty when it is optional ("Optional upload left empty; the agent attaches only your resume and transcript.") and pauses for the candidate when it is required (text answers never fill an upload pause).
An application uses the candidate's alternate (2029) profile when it is Handshake Quick Apply / Apply or its form asks for a transcript; that profile's resume, the transcript, and 2029 graduation answers travel together.
A transcript field without a stored transcript stops the run before anything is filled.
