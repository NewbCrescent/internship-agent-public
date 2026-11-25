A prepared package freezes the resume it will send.
`resumeChangedSincePrepared` compares the job's latest frozen resume document with the one the current entries and profile print; the Review Queue and application pages mark mismatches "Resume changed since prepared".
`refreshApplications` (Refresh with current resume, or Refresh all) rebuilds and re-verifies those packages; runs that were filled but never submitted are cancelled first, the candidate's earlier approval does not carry over, and submitted or submitting applications are never touched.
Rebuilding is local and takes a few milliseconds per application.
The pipeline treats a job whose runs were all cancelled as having no run and fills it again; any other run, including a failed submit, still blocks an automatic run.
