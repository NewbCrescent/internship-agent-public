import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  clipStatedText,
  jobPostingSchema,
  jobPostingStatusSchema,
  postingPublicationSchema,
  type PostingPublication,
  jobRequirementSchema,
  jobSummarySchema,
  verifyTextSpan,
  type ApplicationType,
  type Assertion,
  type CompensationPeriod,
  type EmploymentType,
  type ExtractionMethod,
  type JobCompensation,
  type JobConstraints,
  type JobLocation,
  type JobPosting,
  type JobPostingStatus,
  type JobRequirement,
  type JobSummary,
  type JobTechnology,
  type RequirementCategory,
  type RequirementSubject,
  type TextSpan,
  type JobWorkMode
} from "@internship-agent/domain";

import { hourlyUsdPaySql } from "./posting-filter-sql";

/**
 * Normalizes SQLite datetime strings (e.g. from `datetime('now')` formatted as
 * "YYYY-MM-DD HH:MM:SS" or without timezone offset) into valid ISO-8601 strings
 * required by Zod datetime schema parsing.
 */
export function normalizeSqliteDateTime(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)) {
    return trimmed.replace(" ", "T") + "Z";
  }
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  return trimmed;
}

type SpanColumns = { span_start: number; span_end: number; span_excerpt: string };

type JobRow = {
  id: string;
  company_name: string;
  title: string;
  employment_type: EmploymentType;
  application_type: ApplicationType;
  source_url: string;
  external_application_url: string | null;
  company_careers_url: string | null;
  status: JobPostingStatus;
  created_at: string;
  updated_at: string;
  publication_json: string | null;
};

type SnapshotRow = {
  id: string;
  job_id: string;
  content_hash: string;
  normalized_text: string;
  captured_at: string;
};

type RequirementRow = SpanColumns & {
  id: string;
  job_id: string;
  text: string;
  category: RequirementCategory;
  subject: RequirementSubject;
  extraction: ExtractionMethod;
  assertion: Assertion;
  confidence: number;
};

type LocationRow = SpanColumns & {
  job_id: string;
  raw: string;
  city: string | null;
  region: string | null;
  country_code: string | null;
  work_mode: JobWorkMode;
};

type TechnologyRow = SpanColumns & {
  job_id: string;
  label: string;
  normalized_key: string;
  extraction: ExtractionMethod;
};

type CompensationRow = SpanColumns & {
  raw: string;
  minimum: number | null;
  maximum: number | null;
  currency: string;
  period: CompensationPeriod;
};

type ConstraintRow = SpanColumns & {
  kind: keyof JobConstraints;
  raw: string;
  detail: string;
  extraction: ExtractionMethod;
};

/** What the normalizer produces, before identifiers and timestamps exist. */
export type NormalizedPostingInput = {
  companyName: string;
  title: string;
  employmentType: EmploymentType;
  applicationType: ApplicationType;
  sourceUrl: string;
  externalApplicationUrl: string | null;
  companyCareersUrl: string | null;
  contentHash: string;
  normalizedText: string;
  locations: Array<Omit<JobLocation, "jobId">>;
  compensation: JobCompensation | null;
  requirements: Array<Omit<JobRequirement, "id" | "jobId">>;
  technologies: Array<Omit<JobTechnology, "jobId">>;
  constraints: JobConstraints;
  publication?: PostingPublication | null;
  /**
   * Why the model could not label the requirement lines. When set, the posting
   * is stored with no requirement rows and held for a later labelling retry.
   */
  requirementLabelsPending?: string | null;
};

export type PersistPostingResult = {
  jobId: string;
  status: "CREATED" | "REVISED" | "UNCHANGED";
};

export class ProtectedJobError extends Error {
  constructor(readonly jobId: string) {
    super("A protected posting cannot be revised.");
  }
}

/**
 * A posting is identified by its source URL. Re-ingesting identical content is
 * a no-op so the capture history stays honest about when the posting actually
 * changed; changed content supersedes the prior snapshot and re-derives every
 * dependent row in one transaction.
 */
export function persistNormalizedPosting(
  database: DatabaseSync,
  input: NormalizedPostingInput,
  options: { protectedStatuses?: ReadonlySet<JobPostingStatus> } = {}
): PersistPostingResult {
  const now = new Date().toISOString();
  const publication = input.publication ? postingPublicationSchema.parse(input.publication) : null;
  const existing = database
    .prepare("SELECT * FROM jobs WHERE source_url = ?")
    .get(input.sourceUrl) as JobRow | undefined;

  if (existing) {
    const current = database
      .prepare("SELECT * FROM job_snapshots WHERE job_id = ? AND superseded_at IS NULL")
      .get(existing.id) as SnapshotRow | undefined;
    if (current?.content_hash === input.contentHash) {
      if (publication) savePostingPublication(database, existing.id, publication);
      return { jobId: existing.id, status: "UNCHANGED" };
    }
  }

  const jobId = existing?.id ?? randomUUID();
  database.exec("BEGIN IMMEDIATE;");
  try {
    // Classification may have awaited a model call after discovery's first
    // status check. Recheck under the write lock before replacing a snapshot.
    if (existing && options.protectedStatuses) {
      const status = getJobStatus(database, existing.id);
      if (!status) throw new Error("The posting disappeared during ingestion.");
      if (options.protectedStatuses.has(status)) throw new ProtectedJobError(existing.id);
    }
    database.prepare(`
      INSERT INTO jobs (
        id, company_name, title, employment_type, application_type,
        source_url, external_application_url, company_careers_url,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        company_name = excluded.company_name,
        title = excluded.title,
        employment_type = excluded.employment_type,
        application_type = excluded.application_type,
        external_application_url = excluded.external_application_url,
        company_careers_url = excluded.company_careers_url,
        updated_at = excluded.updated_at
    `).run(
      jobId,
      input.companyName,
      input.title,
      input.employmentType,
      input.applicationType,
      input.sourceUrl,
      input.externalApplicationUrl,
      input.companyCareersUrl,
      existing?.status ?? "DISCOVERED",
      existing?.created_at ?? now,
      now
    );

    if (publication) savePostingPublication(database, jobId, publication);

    database.prepare("UPDATE job_snapshots SET superseded_at = ? WHERE job_id = ? AND superseded_at IS NULL")
      .run(now, jobId);
    const snapshotId = randomUUID();
    database.prepare(`
      INSERT INTO job_snapshots (id, job_id, content_hash, normalized_text, captured_at, superseded_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run(snapshotId, jobId, input.contentHash, input.normalizedText, now);

    for (const table of ["job_locations", "job_requirements", "job_technologies", "job_constraints"]) {
      database.prepare(`DELETE FROM ${table} WHERE job_id = ?`).run(jobId);
    }
    database.prepare("DELETE FROM job_compensation WHERE job_id = ?").run(jobId);
    insertPlaceAndPay(database, jobId, input);

    for (const requirement of input.requirements) {
      database.prepare(`
        INSERT INTO job_requirements (
          id, job_id, text, category, subject, extraction, assertion, confidence,
          span_start, span_end, span_excerpt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), jobId, requirement.text, requirement.category, requirement.subject,
        requirement.extraction, requirement.assertion, requirement.confidence,
        requirement.span.start, requirement.span.end, requirement.span.excerpt
      );
    }

    // A new snapshot replaces any earlier labelling hold; it is held again only
    // when the model could not label this snapshot's requirement lines.
    database.prepare("DELETE FROM requirement_label_holds WHERE job_id = ?").run(jobId);
    if (input.requirementLabelsPending) {
      database.prepare(`
        INSERT INTO requirement_label_holds (job_id, snapshot_id, reason, attempts, created_at, last_attempt_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(jobId, snapshotId, input.requirementLabelsPending.slice(0, 1_000), now, now);
    }

    for (const technology of input.technologies) {
      database.prepare(`
        INSERT INTO job_technologies (
          job_id, normalized_key, label, extraction, span_start, span_end, span_excerpt
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, normalized_key) DO NOTHING
      `).run(
        jobId, technology.normalizedKey, technology.label, technology.extraction,
        technology.span.start, technology.span.end, technology.span.excerpt
      );
    }

    for (const kind of ["graduation", "authorization", "sponsorship", "availability"] as const) {
      const constraint = input.constraints[kind];
      if (!constraint) continue;
      const { raw, extraction, assertion, span, ...detail } = constraint;
      database.prepare(`
        INSERT INTO job_constraints (
          job_id, kind, raw, detail, extraction, assertion, span_start, span_end, span_excerpt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        jobId, kind, raw, JSON.stringify(detail), extraction, assertion,
        span.start, span.end, span.excerpt
      );
    }

    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }

  return { jobId, status: existing ? "REVISED" : "CREATED" };
}

/** Repair requirements derived from an unchanged snapshot, before application preparation. */
export function replaceCurrentJobRequirements(
  database: DatabaseSync,
  jobId: string,
  expectedSnapshotId: string,
  requirements: NormalizedPostingInput["requirements"]
): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const status = getJobStatus(database, jobId);
    if (!status) throw new Error("The posting does not exist.");
    if (!["DISCOVERED", "ANALYZING", "NOT_QUALIFIED", "QUALIFIED"].includes(status)) {
      throw new ProtectedJobError(jobId);
    }
    const snapshot = database.prepare(`
      SELECT * FROM job_snapshots WHERE job_id = ? AND superseded_at IS NULL
    `).get(jobId) as SnapshotRow | undefined;
    if (!snapshot || snapshot.id !== expectedSnapshotId) {
      throw new Error("The posting snapshot changed during requirement repair.");
    }

    const validated = requirements.map((requirement) => {
      const parsed = jobRequirementSchema.parse({ ...requirement, id: randomUUID(), jobId });
      if (!verifyTextSpan(snapshot.normalized_text, parsed.span) || parsed.text !== parsed.span.excerpt) {
        throw new Error("A repaired requirement is not grounded in the current snapshot.");
      }
      return parsed;
    });

    database.prepare("DELETE FROM job_requirements WHERE job_id = ?").run(jobId);
    const insert = database.prepare(`
      INSERT INTO job_requirements (
        id, job_id, text, category, subject, extraction, assertion, confidence,
        span_start, span_end, span_excerpt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const requirement of validated) {
      insert.run(
        requirement.id, jobId, requirement.text, requirement.category, requirement.subject,
        requirement.extraction, requirement.assertion, requirement.confidence,
        requirement.span.start, requirement.span.end, requirement.span.excerpt
      );
    }
    // Labels for the current snapshot have arrived, so any labelling hold ends.
    database.prepare("DELETE FROM requirement_label_holds WHERE job_id = ?").run(jobId);
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/**
 * Lightweight status read for flows that never need the hydrated posting —
 * outcome recording works on any tracked row, snapshot or not.
 */
export function getJobStatus(database: DatabaseSync, jobId: string): JobPostingStatus | null {
  const row = database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as
    { status: JobPostingStatus } | undefined;
  return row?.status ?? null;
}

export function findJobBySourceUrl(
  database: DatabaseSync,
  sourceUrl: string
): { id: string; status: JobPostingStatus } | null {
  const row = database.prepare("SELECT id, status FROM jobs WHERE source_url = ?").get(sourceUrl) as
    { id: string; status: JobPostingStatus } | undefined;
  return row ?? null;
}

/** Current snapshots only; discovery uses these to recognize mirrored postings across source URLs. */
export function listCurrentPostingIdentities(database: DatabaseSync): Array<{
  id: string;
  status: JobPostingStatus;
  companyName: string;
  title: string;
  sourceUrl: string;
  normalizedText: string;
}> {
  const rows = database.prepare(`
    SELECT j.id, j.status, j.company_name, j.title, j.source_url, s.normalized_text
    FROM jobs j
    JOIN job_snapshots s ON s.job_id = j.id AND s.superseded_at IS NULL
  `).all() as Array<Pick<JobRow, "id" | "status" | "company_name" | "title" | "source_url"> & Pick<SnapshotRow, "normalized_text">>;
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    companyName: row.company_name,
    title: row.title,
    sourceUrl: row.source_url,
    normalizedText: row.normalized_text
  }));
}

export function getJobPosting(database: DatabaseSync, jobId: string): JobPosting | null {
  const job = database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
  if (!job) return null;
  const snapshot = database
    .prepare("SELECT * FROM job_snapshots WHERE job_id = ? AND superseded_at IS NULL")
    .get(jobId) as SnapshotRow | undefined;
  if (!snapshot) return null;

  const locations = (database
    .prepare("SELECT * FROM job_locations WHERE job_id = ? ORDER BY span_start")
    .all(jobId) as LocationRow[])
    .map((row) => ({
      jobId,
      raw: row.raw,
      city: row.city,
      region: row.region,
      countryCode: row.country_code,
      workMode: row.work_mode,
      span: toSpan(row)
    }));

  const compensationRow = database
    .prepare("SELECT * FROM job_compensation WHERE job_id = ?")
    .get(jobId) as CompensationRow | undefined;

  const requirements = (database
    .prepare("SELECT * FROM job_requirements WHERE job_id = ? ORDER BY category, span_start")
    .all(jobId) as RequirementRow[])
    .map((row) => ({
      id: row.id,
      jobId,
      text: row.text,
      category: row.category,
      subject: row.subject,
      extraction: row.extraction,
      assertion: row.assertion,
      confidence: row.confidence,
      span: toSpan(row)
    }));

  const technologies = (database
    .prepare("SELECT * FROM job_technologies WHERE job_id = ? ORDER BY normalized_key")
    .all(jobId) as TechnologyRow[])
    .map((row) => ({
      jobId,
      label: row.label,
      normalizedKey: row.normalized_key,
      extraction: row.extraction,
      span: toSpan(row)
    }));

  // Rows stored before extraction kept a window of the constraint text can hold
  // longer text than the schema allows: their raw text (and an over-long span)
  // is clipped on read so the posting still parses. No other read changes, and
  // the write path is unchanged.
  const constraints = (database
    .prepare("SELECT * FROM job_constraints WHERE job_id = ?")
    .all(jobId) as ConstraintRow[])
    .reduce<JobConstraints>((accumulator, row) => ({
      ...accumulator,
      [row.kind]: {
        ...JSON.parse(row.detail) as Record<string, unknown>,
        raw: clipStatedText(row.raw),
        extraction: row.extraction,
        assertion: "STATED" as const,
        span: row.span_excerpt.length > MAX_SPAN_EXCERPT
          ? { start: row.span_start, end: row.span_start + MAX_SPAN_EXCERPT, excerpt: row.span_excerpt.slice(0, MAX_SPAN_EXCERPT) }
          : toSpan(row)
      }
    }), { graduation: null, authorization: null, sponsorship: null, availability: null });

  return jobPostingSchema.parse({
    id: job.id,
    companyName: job.company_name,
    title: job.title,
    employmentType: job.employment_type,
    status: job.status,
    source: {
      applicationType: job.application_type,
      sourceUrl: job.source_url,
      externalApplicationUrl: job.external_application_url,
      companyCareersUrl: job.company_careers_url
    },
    snapshot: {
      id: snapshot.id,
      jobId: snapshot.job_id,
      contentHash: snapshot.content_hash,
      normalizedText: snapshot.normalized_text,
      capturedAt: snapshot.captured_at
    },
    locations,
    compensation: compensationRow ? {
      raw: compensationRow.raw,
      minimum: compensationRow.minimum,
      maximum: compensationRow.maximum,
      currency: compensationRow.currency,
      period: compensationRow.period,
      span: toSpan(compensationRow)
    } : null,
    requirements,
    technologies,
    constraints,
    publication: job.publication_json ? postingPublicationSchema.parse(JSON.parse(job.publication_json)) : null,
    createdAt: normalizeSqliteDateTime(job.created_at),
    updatedAt: normalizeSqliteDateTime(job.updated_at)
  });
}

export function countJobSummaries(database: DatabaseSync, status?: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS total FROM jobs j
    WHERE (? IS NULL OR j.status = ?) AND EXISTS (
      SELECT 1 FROM job_snapshots s WHERE s.job_id = j.id AND s.superseded_at IS NULL
    )`).get(status ?? null, status ?? null) as { total: number };
  return row.total;
}

export function getJobStatusCounts(database: DatabaseSync): Record<string, number> {
  const rows = database.prepare(`SELECT j.status, COUNT(*) AS total FROM jobs j
    WHERE EXISTS (SELECT 1 FROM job_snapshots s WHERE s.job_id = j.id AND s.superseded_at IS NULL)
    GROUP BY j.status`).all() as Array<{ status: string; total: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, row.total]));
}

export function listJobSummaries(
  database: DatabaseSync,
  options: { limit?: number; offset?: number; status?: string } = {}
): JobSummary[] {
  const rows = database.prepare(`
    SELECT
      j.*,
      (SELECT raw FROM job_locations WHERE job_id = j.id ORDER BY span_start LIMIT 1) AS primary_location,
      (SELECT group_concat(DISTINCT country_code) FROM job_locations WHERE job_id = j.id AND country_code IS NOT NULL) AS country_codes,
      ${hourlyUsdPaySql("j.id")} AS hourly_usd_pay,
      (SELECT COUNT(*) FROM job_requirements WHERE job_id = j.id AND category = 'HARD') AS hard_count,
      (SELECT COUNT(*) FROM job_requirements WHERE job_id = j.id AND category = 'PREFERRED') AS preferred_count
    FROM jobs j
    WHERE (? IS NULL OR j.status = ?) AND EXISTS (
      SELECT 1 FROM job_snapshots s
      WHERE s.job_id = j.id AND s.superseded_at IS NULL
    )
    ORDER BY j.created_at DESC, j.id DESC
    LIMIT ? OFFSET ?
  `).all(options.status ?? null, options.status ?? null, options.limit ?? -1, options.offset ?? 0) as Array<JobRow & {
    primary_location: string | null;
    country_codes: string | null;
    hourly_usd_pay: number | null;
    hard_count: number;
    preferred_count: number;
  }>;

  return rows.map((row) => jobSummarySchema.parse({
    id: row.id,
    companyName: row.company_name,
    title: row.title,
    primaryLocation: row.primary_location ?? "Not stated",
    countryCodes: row.country_codes ? row.country_codes.split(",") : [],
    hourlyUsdPay: row.hourly_usd_pay,
    employmentType: row.employment_type,
    applicationType: row.application_type,
    sourceUrl: row.source_url,
    status: row.status,
    hardRequirementCount: row.hard_count,
    preferredRequirementCount: row.preferred_count,
    publication: row.publication_json ? postingPublicationSchema.parse(JSON.parse(row.publication_json)) : null,
    createdAt: normalizeSqliteDateTime(row.created_at)
  }));
}

export function listJobPostings(database: DatabaseSync): JobPosting[] {
  return listJobSummaries(database)
    .map((summary) => getJobPosting(database, summary.id))
    .filter((posting): posting is JobPosting => posting !== null);
}

export type PlaceAndPay = {
  locations: Array<Omit<JobLocation, "jobId">>;
  compensation: JobCompensation | null;
};

function insertPlaceAndPay(database: DatabaseSync, jobId: string, input: PlaceAndPay): void {
  for (const location of input.locations) {
    database.prepare(`
      INSERT INTO job_locations (
        id, job_id, raw, city, region, country_code, work_mode,
        span_start, span_end, span_excerpt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), jobId, location.raw, location.city, location.region,
      location.countryCode, location.workMode,
      location.span.start, location.span.end, location.span.excerpt
    );
  }

  if (input.compensation) {
    database.prepare(`
      INSERT INTO job_compensation (
        job_id, raw, minimum, maximum, currency, period,
        span_start, span_end, span_excerpt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobId, input.compensation.raw, input.compensation.minimum, input.compensation.maximum,
      input.compensation.currency, input.compensation.period,
      input.compensation.span.start, input.compensation.span.end, input.compensation.span.excerpt
    );
  }
}

/** Every posting's current snapshot text, for re-reading stored postings without fetching them. */
export function listCurrentPostingTexts(database: DatabaseSync): Array<{
  jobId: string; companyName: string; title: string; normalizedText: string; postedAt: string | null;
}> {
  return (database.prepare(`
    SELECT j.id AS job_id, j.company_name, j.title, s.normalized_text, json_extract(j.publication_json, '$.postedAt') AS posted_at
    FROM jobs j JOIN job_snapshots s ON s.job_id = j.id AND s.superseded_at IS NULL
    ORDER BY j.created_at, j.id
  `).all() as Array<{ job_id: string; company_name: string; title: string; normalized_text: string; posted_at: string | null }>)
    .map((row) => ({ jobId: row.job_id, companyName: row.company_name, title: row.title, normalizedText: row.normalized_text, postedAt: row.posted_at }));
}

/**
 * Postings owed an analysis, oldest first (created_at, then id): DISCOVERED
 * with no match report, or any status not in `excludedStatuses` whose match
 * report is older than its current snapshot (a revision whose analysis was
 * deferred). Postings skipped by discovery feedback or held for requirement
 * labels are left out.
 */
export function listPostingsAwaitingAnalysis(database: DatabaseSync, options: { excludedStatuses: readonly string[] }): string[] {
  return (database.prepare(`
    SELECT j.id FROM jobs j
    JOIN job_snapshots s ON s.job_id = j.id AND s.superseded_at IS NULL
    LEFT JOIN job_matches m ON m.job_id = j.id
    WHERE NOT EXISTS (SELECT 1 FROM discovery_feedback f WHERE f.job_id = j.id)
      AND NOT EXISTS (SELECT 1 FROM requirement_label_holds h WHERE h.job_id = j.id)
      AND (
        (m.job_id IS NULL AND j.status = 'DISCOVERED')
        OR (m.job_id IS NOT NULL AND m.evaluated_at < s.captured_at
            AND j.status NOT IN (SELECT value FROM json_each(?)))
      )
    ORDER BY j.created_at ASC, j.id ASC
  `).all(JSON.stringify(options.excludedStatuses)) as Array<{ id: string }>).map((row) => row.id);
}

/** Current postings whose snapshot has no "Location: " line and no location row with a country, for the board-location backfill (Track 73). */
export function listPostingsWithoutStatedLocation(database: DatabaseSync): Array<{
  jobId: string; companyName: string; title: string; status: JobPostingStatus; sourceUrl: string;
}> {
  return (database.prepare(`
    SELECT j.id, j.company_name, j.title, j.status, j.source_url FROM jobs j
    JOIN job_snapshots s ON s.job_id = j.id AND s.superseded_at IS NULL
    WHERE substr(s.normalized_text, 1, 10) <> 'Location: '
      AND instr(s.normalized_text, char(10) || 'Location: ') = 0
      AND NOT EXISTS (SELECT 1 FROM job_locations l WHERE l.job_id = j.id AND l.country_code IS NOT NULL)
    ORDER BY j.company_name, j.title, j.id
  `).all() as Array<{ id: string; company_name: string; title: string; status: string; source_url: string }>)
    .map((row) => ({
      jobId: row.id,
      companyName: row.company_name,
      title: row.title,
      status: jobPostingStatusSchema.parse(row.status),
      sourceUrl: row.source_url
    }));
}

export function getPlaceAndPay(database: DatabaseSync, jobId: string): PlaceAndPay {
  const locations = (database.prepare("SELECT * FROM job_locations WHERE job_id = ? ORDER BY span_start")
    .all(jobId) as LocationRow[]).map((row) => ({
    raw: row.raw, city: row.city, region: row.region, countryCode: row.country_code, workMode: row.work_mode, span: toSpan(row)
  }));
  const row = database.prepare("SELECT * FROM job_compensation WHERE job_id = ?").get(jobId) as CompensationRow | undefined;
  return {
    locations,
    compensation: row ? {
      raw: row.raw, minimum: row.minimum, maximum: row.maximum, currency: row.currency, period: row.period, span: toSpan(row)
    } : null
  };
}

/**
 * Replaces only a posting's location and pay rows, in one transaction per
 * batch the caller opens. The snapshot, requirements, match report, package,
 * and status are untouched; every span must still quote the stored snapshot.
 */
export function replacePlaceAndPay(database: DatabaseSync, jobId: string, input: PlaceAndPay): void {
  const snapshot = database.prepare("SELECT normalized_text FROM job_snapshots WHERE job_id = ? AND superseded_at IS NULL")
    .get(jobId) as { normalized_text: string } | undefined;
  if (!snapshot) throw new Error(`Posting ${jobId} has no current snapshot.`);
  const spans = [...input.locations.map((location) => location.span), ...(input.compensation ? [input.compensation.span] : [])];
  if (!spans.every((span) => verifyTextSpan(snapshot.normalized_text, span))) {
    throw new Error(`A location or pay span for ${jobId} does not quote its stored snapshot.`);
  }
  database.prepare("DELETE FROM job_locations WHERE job_id = ?").run(jobId);
  database.prepare("DELETE FROM job_compensation WHERE job_id = ?").run(jobId);
  insertPlaceAndPay(database, jobId, input);
}

/** textSpanSchema's longest excerpt. */
const MAX_SPAN_EXCERPT = 2_000;

function toSpan(row: SpanColumns): TextSpan {
  return { start: row.span_start, end: row.span_end, excerpt: row.span_excerpt };
}

/** Metadata-only update: never rewrites snapshots, match reports, or application state. */
export function savePostingPublication(database: DatabaseSync, jobId: string, publication: PostingPublication): void {
  const parsed = postingPublicationSchema.parse(publication);
  database.prepare("UPDATE jobs SET publication_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(parsed), new Date().toISOString(), jobId);
}

/** Job ids starting with this prefix (8 to 36 hex characters or dashes), newest first; at most three. */
export function findJobIds(database: DatabaseSync, prefix: string): string[] {
  if (!/^[0-9a-f-]{8,36}$/i.test(prefix)) return [];
  const rows = database.prepare(`
    SELECT id FROM jobs WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 3
  `).all(`${prefix.toLowerCase()}%`) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}
