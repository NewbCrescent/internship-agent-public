import { countryFilterSql, hourlyUsdPaySql, joinFragments, minPayFilterSql, type SqlFragment } from "./posting-filter-sql";
import { CURRENT_SEMANTIC_FIT_JOIN } from "./semantic-fit-repository";
import { NO_STATED_COUNTRY, type ReviewQueueSort } from "@internship-agent/domain";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  applicationPackageSchema,
  resumeBulletSchema,
  resumeDocumentSchema,
  resumeVariantSchema,
  verificationReportSchema,
  type ApplicationPackage,
  type CompensationPeriod,
  type JobPostingStatus,
  type ResumeBullet,
  type ResumeDocument,
  type ResumeVariant,
  type VerificationReport
} from "@internship-agent/domain";

type PackageRow = {
  id: string;
  job_id: string;
  created_at: string;
  package_json: string;
  verification_json: string | null;
  blocked: number | null;
};

type VariantRow = {
  id: string;
  candidate_id: string;
  job_id: string | null;
  label: string;
  bullets_json: string;
  rendered_markdown: string;
  document_json: string | null;
  created_at: string;
};

export type ApplicationEvent = {
  id: string;
  jobId: string;
  fromStatus: JobPostingStatus | null;
  toStatus: JobPostingStatus;
  detail: string | null;
  createdAt: string;
};

/**
 * Packages are versioned: preparing again supersedes the current row rather
 * than overwriting it, so the review history stays honest about what changed.
 */
export function saveApplicationPackage(
  database: DatabaseSync,
  package_: ApplicationPackage
): ApplicationPackage {
  const parsed = applicationPackageSchema.parse(package_);
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.prepare("UPDATE application_packages SET superseded_at = ? WHERE job_id = ? AND superseded_at IS NULL")
      .run(now, parsed.jobId);
    database.prepare(`
      INSERT INTO application_packages (id, job_id, created_at, package_json, verification_json, blocked, superseded_at)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL)
    `).run(parsed.id, parsed.jobId, parsed.createdAt, JSON.stringify(parsed));
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  return parsed;
}

export function saveVerificationReport(
  database: DatabaseSync,
  report: VerificationReport
): VerificationReport {
  const parsed = verificationReportSchema.parse(report);
  const result = database.prepare(`
    UPDATE application_packages
    SET verification_json = ?, blocked = ?
    WHERE id = ? AND superseded_at IS NULL
  `).run(JSON.stringify(parsed), parsed.blocked ? 1 : 0, parsed.packageId);
  if (Number(result.changes) !== 1) throw new Error("The package is gone or superseded; verify the current one.");
  return parsed;
}

export type CurrentPackage = {
  package: ApplicationPackage;
  verification: VerificationReport | null;
  blocked: boolean | null;
};

export type ReviewQueueEntry = {
  jobId: string;
  companyName: string;
  title: string;
  status: "READY_FOR_REVIEW" | "NEEDS_INPUT" | "APPLYING";
  blocked: boolean | null;
  /** For APPLYING entries: the latest browser run, awaiting approval or paused for input. */
  runStatus: "awaiting-approval" | "paused-needs-input" | null;
  updatedAt: string;
  fitScore: number | null;
  aiFit: boolean;
  aiRating: string | null;
  aiConfidence: string | null;
  postedAt: string | null;
  /** Stated pay as written in the posting's units, or null. */
  pay: { minimum: number | null; maximum: number | null; currency: string; period: CompensationPeriod } | null;
  /** Comparable USD per hour, or null when not stated in USD. */
  hourlyUsdPay: number | null;
  primaryLocation: string | null;
  countryCodes: string[];
  sourceUrl: string;
  externalApplicationUrl: string | null;
  companyCareersUrl: string | null;
  /** The newest resume prepared for this application, for the PDF link. */
  latestVariantId: string | null;
};

const REVIEW_QUEUE_SQL = `
    SELECT * FROM (
      SELECT j.id AS job_id, j.company_name, j.title, j.status, j.updated_at, j.created_at,
        ai.score AS fit_score, ai.score AS ai_score, json_extract(ai.assessment_json, '$.rating') AS ai_rating, json_extract(ai.assessment_json, '$.confidence') AS ai_confidence, json_extract(j.publication_json, '$.postedAt') AS posted_at,
        (SELECT blocked FROM application_packages WHERE job_id = j.id AND superseded_at IS NULL) AS blocked,
        j.source_url, j.external_application_url, j.company_careers_url,
        (SELECT raw FROM job_locations WHERE job_id = j.id ORDER BY span_start LIMIT 1) AS primary_location,
        (SELECT group_concat(DISTINCT country_code) FROM job_locations WHERE job_id = j.id AND country_code IS NOT NULL) AS country_codes,
        ${hourlyUsdPaySql("j.id")} AS hourly_usd_pay,
        (SELECT json_object('minimum', c.minimum, 'maximum', c.maximum, 'currency', c.currency, 'period', c.period)
          FROM job_compensation c WHERE c.job_id = j.id) AS pay_json,
        (SELECT v.id FROM resume_variants v WHERE v.job_id = j.id ORDER BY v.created_at DESC LIMIT 1) AS latest_variant_id,
        (SELECT r.status FROM browser_runs r WHERE r.job_id = j.id ORDER BY r.updated_at DESC LIMIT 1) AS run_status
      FROM jobs j LEFT JOIN job_matches m ON m.job_id = j.id ${CURRENT_SEMANTIC_FIT_JOIN}
      WHERE j.status IN ('READY_FOR_REVIEW', 'NEEDS_INPUT', 'APPLYING')
        AND NOT EXISTS (SELECT 1 FROM discovery_feedback f WHERE f.job_id = j.id)
    ) AS q
    -- A filled application waiting on the candidate belongs in the queue too.
    WHERE (status != 'APPLYING' OR run_status IN ('awaiting-approval', 'paused-needs-input'))
`;

type ReviewQueueReadOptions = {
  sort?: ReviewQueueSort;
  postedWithinDays?: number | null;
  now?: number;
  country?: string | null;
  minHourlyPay?: number | null;
};

function reviewAgeWindow(options: ReviewQueueReadOptions): SqlFragment {
  if (options.postedWithinDays == null) return { sql: "", parameters: [] };
  const now = options.now ?? Date.now();
  return { sql: " AND julianday(posted_at) BETWEEN julianday(?) AND julianday(?)",
    parameters: [new Date(now - options.postedWithinDays * 86_400_000).toISOString(), new Date(now).toISOString()] };
}

function reviewFilters(options: ReviewQueueReadOptions): SqlFragment {
  return joinFragments(reviewAgeWindow(options), countryFilterSql("q.job_id", options.country ?? null),
    minPayFilterSql("q.job_id", options.minHourlyPay ?? null));
}

function countReviewRows(database: DatabaseSync, filter: SqlFragment): number {
  return (database.prepare(`SELECT COUNT(*) AS total FROM (${REVIEW_QUEUE_SQL}${filter.sql})`)
    .get(...filter.parameters) as { total: number }).total;
}

export function countReviewQueue(database: DatabaseSync, options: ReviewQueueReadOptions = {}): number {
  return countReviewRows(database, reviewFilters(options));
}

/**
 * Entries a filter hides only because the posting is silent: no stated
 * country under a country filter, or no comparable USD pay under a minimum.
 * Each count applies the filters before it, as the list does.
 */
export function countReviewQueueUnstated(database: DatabaseSync, options: ReviewQueueReadOptions): { country: number; pay: number } {
  const age = reviewAgeWindow(options);
  const country = options.country ?? null;
  return {
    country: country && country !== NO_STATED_COUNTRY
      ? countReviewRows(database, joinFragments(age, countryFilterSql("q.job_id", NO_STATED_COUNTRY))) : 0,
    pay: options.minHourlyPay != null
      ? countReviewRows(database, joinFragments(age, countryFilterSql("q.job_id", country),
        { sql: ` AND ${hourlyUsdPaySql("q.job_id")} IS NULL`, parameters: [] })) : 0
  };
}

/** Countries in the queue within the age window, most entries first, plus entries that state none. */
export function listReviewQueueCountries(database: DatabaseSync, options: ReviewQueueReadOptions = {}): {
  countries: Array<{ code: string; count: number }>;
  unstated: number;
} {
  const age = reviewAgeWindow(options);
  const countries = database.prepare(`
    SELECT l.country_code AS code, COUNT(DISTINCT r.job_id) AS count
    FROM (${REVIEW_QUEUE_SQL}${age.sql}) r JOIN job_locations l ON l.job_id = r.job_id
    WHERE l.country_code IS NOT NULL
    GROUP BY l.country_code ORDER BY count DESC, code
  `).all(...age.parameters) as Array<{ code: string; count: number }>;
  return { countries, unstated: countReviewRows(database, joinFragments(age, countryFilterSql("q.job_id", NO_STATED_COUNTRY))) };
}

export function countReviewQueueUnknownDates(database: DatabaseSync): number {
  return (database.prepare(`SELECT COUNT(*) AS total FROM (${REVIEW_QUEUE_SQL} AND posted_at IS NULL)`)
    .get() as { total: number }).total;
}

export function listReviewQueue(database: DatabaseSync,
  options: ReviewQueueReadOptions & { limit?: number; offset?: number } = {}
): ReviewQueueEntry[] {
  const filter = reviewFilters(options);
  const order = options.sort === "fit" ? "fit_score IS NULL, fit_score DESC, created_at DESC, job_id DESC"
    : options.sort === "newest" ? "created_at DESC, job_id DESC" : "updated_at DESC, job_id DESC";
  const rows = database.prepare(`${REVIEW_QUEUE_SQL}${filter.sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...filter.parameters, options.limit ?? -1, options.offset ?? 0) as Array<{
    job_id: string; company_name: string; title: string;
    status: ReviewQueueEntry["status"]; blocked: number | null; run_status: string | null; updated_at: string;
    fit_score: number | null; ai_score: number | null; ai_rating: string | null; ai_confidence: string | null; posted_at: string | null;
    source_url: string; external_application_url: string | null; company_careers_url: string | null;
    primary_location: string | null; country_codes: string | null; hourly_usd_pay: number | null; pay_json: string | null;
    latest_variant_id: string | null;
  }>;
  return rows.map((row) => ({
    jobId: row.job_id,
    companyName: row.company_name,
    title: row.title,
    status: row.status,
    blocked: row.blocked === null ? null : row.blocked === 1,
    runStatus: row.status === "APPLYING" && (row.run_status === "awaiting-approval" || row.run_status === "paused-needs-input")
      ? row.run_status
      : null,
    updatedAt: row.updated_at,
    fitScore: row.fit_score,
    aiFit: row.ai_score !== null,
    aiRating: row.ai_rating,
    aiConfidence: row.ai_confidence,
    postedAt: row.posted_at,
    pay: row.pay_json ? JSON.parse(row.pay_json) as ReviewQueueEntry["pay"] : null,
    hourlyUsdPay: row.hourly_usd_pay,
    primaryLocation: row.primary_location,
    countryCodes: row.country_codes ? row.country_codes.split(",") : [],
    sourceUrl: row.source_url,
    externalApplicationUrl: row.external_application_url,
    companyCareersUrl: row.company_careers_url,
    latestVariantId: row.latest_variant_id
  }));
}

export function getCurrentPackage(database: DatabaseSync, jobId: string): CurrentPackage | null {
  const row = database.prepare(`
    SELECT * FROM application_packages WHERE job_id = ? AND superseded_at IS NULL
  `).get(jobId) as PackageRow | undefined;
  if (!row) return null;
  return {
    package: applicationPackageSchema.parse(JSON.parse(row.package_json)),
    verification: row.verification_json
      ? verificationReportSchema.parse(JSON.parse(row.verification_json))
      : null,
    blocked: row.blocked === null ? null : row.blocked === 1
  };
}

export function saveResumeVariant(
  database: DatabaseSync,
  variant: ResumeVariant,
  renderedMarkdown: string
): ResumeVariant {
  const parsed = resumeVariantSchema.parse(variant);
  const bullets = (JSON.parse(JSON.stringify(parsed.bullets)) as unknown[]).map((bullet) =>
    resumeBulletSchema.parse(bullet)
  );
  database.prepare(`
    INSERT INTO resume_variants (id, candidate_id, job_id, label, bullets_json, rendered_markdown, document_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parsed.id, parsed.candidateId, parsed.jobId, parsed.label,
    JSON.stringify(bullets), renderedMarkdown,
    parsed.document ? JSON.stringify(parsed.document) : null, parsed.createdAt
  );
  return parsed;
}

export function getResumeVariantMarkdown(database: DatabaseSync, variantId: string): string | null {
  const row = database.prepare("SELECT rendered_markdown FROM resume_variants WHERE id = ?")
    .get(variantId) as { rendered_markdown: string } | undefined;
  return row?.rendered_markdown ?? null;
}

/** The frozen structured resume, when the variant has one. */
export function getResumeVariantDocument(database: DatabaseSync, variantId: string): ResumeDocument | null {
  const row = database.prepare("SELECT document_json FROM resume_variants WHERE id = ?")
    .get(variantId) as { document_json: string | null } | undefined;
  return row?.document_json ? resumeDocumentSchema.parse(JSON.parse(row.document_json)) : null;
}

export function listResumeVariants(database: DatabaseSync, jobId: string, limit = -1): ResumeVariant[] {
  const rows = database.prepare(`
    SELECT * FROM resume_variants WHERE job_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(jobId, limit) as VariantRow[];
  return rows.map((row) => resumeVariantSchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    jobId: row.job_id,
    label: row.label,
    bullets: (JSON.parse(row.bullets_json) as unknown[]).map((bullet) =>
      resumeBulletSchema.parse(bullet)
    ),
    document: row.document_json ? JSON.parse(row.document_json) : null,
    createdAt: row.created_at
  }));
}

export function getResumeVariant(database: DatabaseSync, variantId: string): ResumeVariant | null {
  const row = database.prepare("SELECT * FROM resume_variants WHERE id = ?")
    .get(variantId) as VariantRow | undefined;
  if (!row) return null;
  return resumeVariantSchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    jobId: row.job_id,
    label: row.label,
    bullets: (JSON.parse(row.bullets_json) as unknown[]).map((bullet) =>
      resumeBulletSchema.parse(bullet)
    ),
    document: row.document_json ? JSON.parse(row.document_json) : null,
    createdAt: row.created_at
  });
}

export function logApplicationEvent(
  database: DatabaseSync,
  event: { jobId: string; fromStatus: JobPostingStatus | null; toStatus: JobPostingStatus; detail?: string }
): ApplicationEvent {
  const record: ApplicationEvent = {
    id: randomUUID(),
    jobId: event.jobId,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    detail: event.detail ?? null,
    createdAt: new Date().toISOString()
  };
  database.prepare(`
    INSERT INTO application_events (id, job_id, from_status, to_status, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(record.id, record.jobId, record.fromStatus, record.toStatus, record.detail, record.createdAt);
  return record;
}

export function listApplicationEvents(database: DatabaseSync, jobId: string): ApplicationEvent[] {
  const rows = database.prepare(`
    SELECT * FROM application_events WHERE job_id = ? ORDER BY created_at
  `).all(jobId) as Array<{
    id: string; job_id: string; from_status: string | null; to_status: JobPostingStatus;
    detail: string | null; created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    fromStatus: row.from_status as JobPostingStatus | null,
    toStatus: row.to_status,
    detail: row.detail,
    createdAt: row.created_at
  }));
}

/** Events across all jobs whose detail starts with `detailPrefix`, logged at or after `sinceIso`. */
export function countApplicationEventsSince(database: DatabaseSync, detailPrefix: string, sinceIso: string): number {
  const row = database.prepare(`
    SELECT COUNT(*) AS count FROM application_events WHERE substr(detail, 1, ?) = ? AND created_at >= ?
  `).get(detailPrefix.length, detailPrefix, sinceIso) as { count: number };
  return row.count;
}

/** Events across all jobs whose detail starts with `detailPrefix`, logged at or after `sinceIso`, oldest first. */
export function listApplicationEventsSince(database: DatabaseSync, detailPrefix: string, sinceIso: string): ApplicationEvent[] {
  const rows = database.prepare(`
    SELECT * FROM application_events WHERE substr(detail, 1, ?) = ? AND created_at >= ? ORDER BY created_at
  `).all(detailPrefix.length, detailPrefix, sinceIso) as Array<{
    id: string; job_id: string; from_status: string | null; to_status: JobPostingStatus;
    detail: string | null; created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    fromStatus: row.from_status as JobPostingStatus | null,
    toStatus: row.to_status,
    detail: row.detail,
    createdAt: row.created_at
  }));
}

/** Jobs that ever entered SUBMITTED, oldest submission first. */
export function listSubmittedJobIds(database: DatabaseSync): string[] {
  const rows = database.prepare(`
    SELECT job_id AS jobId, MIN(created_at) AS submittedAt FROM application_events
    WHERE to_status = 'SUBMITTED' GROUP BY job_id ORDER BY submittedAt
  `).all() as Array<{ jobId: string; submittedAt: string }>;
  return rows.map((row) => row.jobId);
}

export function setJobStatus(
  database: DatabaseSync,
  jobId: string,
  fromStatus: JobPostingStatus | null,
  toStatus: JobPostingStatus,
  detail?: string
): ApplicationEvent {
  const current = database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as
    { status: JobPostingStatus } | undefined;
  if (!current) throw new Error("The posting is unknown.");
  database.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?")
    .run(toStatus, new Date().toISOString(), jobId);
  return logApplicationEvent(database, { jobId, fromStatus: fromStatus ?? current.status, toStatus, detail });
}

export type { ApplicationPackage, ResumeBullet, ResumeVariant, VerificationReport };
