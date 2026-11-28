# SmartRecruiters application pages show DataDome to the agent's browser

A SmartRecruiters posting's "I'm interested" leads to
`/oneclick-ui/company/<company>/publication/<id>`, which showed a DataDome
CAPTCHA page to a fresh, headful capture browser on 2026-11-24, as it did to
the headless one on 2026-11-19. The agent never solves it: an automatic run
stops with "The application page at jobs.smartrecruiters.com showed a
DataDome CAPTCHA page; the agent never solves CAPTCHAs, so start this
application yourself.", and a candidate-started run is held on the
challenge. The form behind it could not be read, so no adapter fills it, and
`smartrecruiters` stays in `ATS_KINDS_NEEDING_APPROVAL` (its own success text
"Application submitted!" was found in the page's translation bundle, but
the form walk and its regression are missing). Next step: a read-only capture
of the application form from a session the candidate opens.

Update 2026-11-28 (Track 80): SmartRecruiters is the one kind the auto-submit policy still never submits (`ATS_KINDS_NEVER_AUTO_SUBMITTED`).
