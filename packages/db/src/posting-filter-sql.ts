import { NO_STATED_COUNTRY, WORK_HOURS_PER_YEAR } from "@internship-agent/domain";

/**
 * SQL for the country and minimum-pay filters, shared by the Review Queue and
 * the Jobs summaries so both read pay the same way. `jobId` is a trusted
 * column reference such as "q.job_id", never user input.
 */
export type SqlFragment = { sql: string; parameters: Array<string | number> };

/**
 * USD per hour from a posting's stated pay: the top of the range, with monthly
 * and yearly pay converted at WORK_HOURS_PER_YEAR. Null when pay is not
 * stated, is a stipend without an amount, or is not in USD.
 */
export function hourlyUsdPaySql(jobId: string): string {
  return `(SELECT CASE WHEN c.currency = 'USD' THEN CASE c.period
      WHEN 'HOUR' THEN COALESCE(c.maximum, c.minimum)
      WHEN 'MONTH' THEN COALESCE(c.maximum, c.minimum) * 12.0 / ${WORK_HOURS_PER_YEAR}
      WHEN 'YEAR' THEN COALESCE(c.maximum, c.minimum) * 1.0 / ${WORK_HOURS_PER_YEAR} END END
    FROM job_compensation c WHERE c.job_id = ${jobId})`;
}

/** A posting with places in several countries matches each of them. */
export function countryFilterSql(jobId: string, country: string | null): SqlFragment {
  if (country === null) return { sql: "", parameters: [] };
  if (country === NO_STATED_COUNTRY) {
    return { sql: ` AND NOT EXISTS (SELECT 1 FROM job_locations l WHERE l.job_id = ${jobId} AND l.country_code IS NOT NULL)`, parameters: [] };
  }
  return { sql: ` AND EXISTS (SELECT 1 FROM job_locations l WHERE l.job_id = ${jobId} AND l.country_code = ?)`, parameters: [country] };
}

/** Postings without a comparable USD figure compare as NULL, so they never pass. */
export function minPayFilterSql(jobId: string, minHourlyPay: number | null): SqlFragment {
  if (minHourlyPay === null) return { sql: "", parameters: [] };
  return { sql: ` AND ${hourlyUsdPaySql(jobId)} >= ?`, parameters: [minHourlyPay] };
}

export function joinFragments(...fragments: SqlFragment[]): SqlFragment {
  return { sql: fragments.map((fragment) => fragment.sql).join(""), parameters: fragments.flatMap((fragment) => fragment.parameters) };
}
