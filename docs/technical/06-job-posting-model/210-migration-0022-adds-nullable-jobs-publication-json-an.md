Migration 0022 adds nullable `jobs.publication_json`: an ISO UTC `postedAt`, employer source URL, exact source field, and timestamp/date precision.
Discovery carries Greenhouse `first_published`, Ashby `publishedAt` (latest publication), Workday `startDate`, SmartRecruiters `releasedDate`, and Oracle `ExternalPostedStartDate` when explicitly present and valid.
Workday calendar dates are represented at UTC midnight, so the rolling-hour boundary conservatively excludes a partially overlapping oldest day.
Import timestamps, update timestamps, closing dates, aggregator dates, and Lever's undocumented creation field never stand in for employer publication.
Missing, malformed, and future source dates stay unknown.
Pasted postings leave this metadata unset unless explicitly supplied to ingestion.
Re-ingesting identical text may attach publication metadata without replacing its snapshot or changing application state.
