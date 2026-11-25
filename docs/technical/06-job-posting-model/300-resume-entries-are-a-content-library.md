Resume entries are a content library (migration 0020): each entry carries `on_resume` (default on), toggled on the Resume page with Leave off resume / Put on resume.
Toggling never creates a revision.
Only entries on the resume print (`buildResumeDocument`) and feed the application package's resume bullets (`approvedEntries`), so the package matches the PDF sent; approved entries left off stay available to voice drafting (`draftSourcesFor`) and to application-form work history.
