/**
 * Milestone 0 exposed a flat `Job` row. Milestone 3 replaced it with the
 * normalized posting in `job-posting.ts`; `JobSummary` is the list projection
 * that the Overview and Jobs tables read.
 */
export {
  jobSummarySchema,
  type JobSummary
} from "./job-posting";
