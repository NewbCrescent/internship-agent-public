import type { DatabaseSync } from "node:sqlite";
import { countJobSummaries, listJobSummaries } from "@internship-agent/db";
import { jobPostingStatusSchema, listPageBounds } from "@internship-agent/domain";

export function getDashboardJobsPage(database: DatabaseSync, input: { page?: unknown; status?: unknown } = {}, pageSize = 50) {
  const parsed = jobPostingStatusSchema.safeParse(input.status);
  const status = parsed.success ? parsed.data : undefined;
  const bounds = listPageBounds(countJobSummaries(database, status), input.page, pageSize);
  return { ...bounds, status, jobs: listJobSummaries(database, { status, limit: pageSize, offset: bounds.offset }) };
}
