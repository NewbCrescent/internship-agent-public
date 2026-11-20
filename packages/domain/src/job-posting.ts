import { z } from "zod";
import { postingPublicationSchema } from "./posting-publication";

/**
 * A half-open character range into a posting snapshot's normalized text.
 * `excerpt` must equal `normalizedText.slice(start, end)`; ingestion verifies
 * that before persisting, so a span can never point at text the posting
 * does not actually contain.
 */
export const textSpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  excerpt: z.string().min(1).max(2_000)
}).refine((span) => span.end > span.start, {
  message: "A text span must end after it starts."
}).refine((span) => span.end - span.start === span.excerpt.length, {
  message: "A text span's length must match its excerpt."
});

export const applicationTypeSchema = z.enum([
  "HANDSHAKE_INTERNAL",
  "EXTERNAL_ATS",
  "EMPLOYER_SITE",
  "UNKNOWN"
]);

export const employmentTypeSchema = z.enum(["INTERNSHIP", "CO_OP", "NEW_GRAD", "OTHER"]);
/** The mode a posting states. Distinct from a candidate work-mode preference. */
export const jobWorkModeSchema = z.enum(["ONSITE", "HYBRID", "REMOTE", "UNSPECIFIED"]);
export const compensationPeriodSchema = z.enum(["HOUR", "MONTH", "YEAR", "STIPEND"]);
export const requirementCategorySchema = z.enum(["HARD", "PREFERRED"]);
export const requirementSubjectSchema = z.enum([
  "DEGREE",
  "GRADUATION",
  "AUTHORIZATION",
  "LOCATION",
  "AVAILABILITY",
  "SKILL",
  "EXPERIENCE",
  "OTHER"
]);
export const extractionMethodSchema = z.enum(["DETERMINISTIC", "MODEL"]);

/**
 * `STATED` means the posting itself says this at the recorded span.
 * `INFERRED` means the span only supports the reading indirectly.
 * Milestone 4 eligibility must keep the two apart, and must further keep both
 * apart from a field being absent, which means the posting is silent.
 */
export const assertionSchema = z.enum(["STATED", "INFERRED"]);

export const jobPostingStatusSchema = z.enum([
  "DISCOVERED",
  "ANALYZING",
  "NOT_QUALIFIED",
  "QUALIFIED",
  "PREPARING",
  "NEEDS_INPUT",
  "READY_FOR_REVIEW",
  "APPROVED",
  "APPLYING",
  "SUBMITTED",
  "INTERVIEW",
  "REJECTED",
  "OFFER",
  "WITHDRAWN"
]);

export const jobSourceSchema = z.object({
  applicationType: applicationTypeSchema,
  sourceUrl: z.url(),
  externalApplicationUrl: z.url().nullable(),
  companyCareersUrl: z.url().nullable()
});

export const jobSnapshotSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  contentHash: z.string().min(1),
  normalizedText: z.string().min(1).max(200_000),
  capturedAt: z.iso.datetime()
});

export const jobRequirementSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  text: z.string().min(1).max(1_000),
  category: requirementCategorySchema,
  subject: requirementSubjectSchema,
  extraction: extractionMethodSchema,
  assertion: assertionSchema,
  confidence: z.number().min(0).max(1),
  span: textSpanSchema
}).superRefine((requirement, context) => {
  if (requirement.category === "HARD" && requirement.assertion !== "STATED") {
    context.addIssue({
      code: "custom",
      path: ["category"],
      message: "A hard requirement must be stated by the posting, never inferred."
    });
  }
});

export const jobTechnologySchema = z.object({
  jobId: z.string().uuid(),
  label: z.string().trim().min(1).max(80),
  normalizedKey: z.string().min(1).max(80),
  extraction: extractionMethodSchema,
  span: textSpanSchema
});

export const jobLocationSchema = z.object({
  jobId: z.string().uuid(),
  raw: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(120).nullable(),
  region: z.string().trim().min(1).max(120).nullable(),
  countryCode: z.string().trim().length(2).nullable(),
  workMode: jobWorkModeSchema,
  span: textSpanSchema
});

export const jobCompensationSchema = z.object({
  raw: z.string().trim().min(1).max(200),
  minimum: z.number().nonnegative().nullable(),
  maximum: z.number().nonnegative().nullable(),
  currency: z.string().length(3),
  period: compensationPeriodSchema,
  span: textSpanSchema
}).refine(
  (value) => value.minimum === null || value.maximum === null || value.maximum >= value.minimum,
  { message: "Compensation maximum must be at or above its minimum." }
);

/** The longest stated-constraint text (`raw`) a posting keeps. */
export const STATED_CONSTRAINT_MAX_LENGTH = 600;

/**
 * Clips stated-constraint text to the schema limit, deterministically: the
 * trimmed text's first `max` characters, never ending on half of a surrogate
 * pair. Text that already fits is returned unchanged.
 */
export function clipStatedText(text: string, max = STATED_CONSTRAINT_MAX_LENGTH): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return text;
  let out = trimmed.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out.trimEnd();
}

/**
 * Every constraint is stated or absent. A posting that is silent about
 * sponsorship yields `null`, which is not the same as "sponsorship offered".
 */
const statedConstraint = {
  raw: z.string().trim().min(1).max(STATED_CONSTRAINT_MAX_LENGTH),
  extraction: extractionMethodSchema,
  assertion: z.literal("STATED"),
  span: textSpanSchema
};

export const graduationConstraintSchema = z.object({
  earliest: z.iso.date().nullable(),
  latest: z.iso.date().nullable(),
  ...statedConstraint
});

export const authorizationConstraintSchema = z.object({
  requiresExistingAuthorization: z.boolean(),
  countryCode: z.string().trim().length(2).nullable(),
  ...statedConstraint
});

export const sponsorshipConstraintSchema = z.object({
  sponsorshipAvailable: z.boolean(),
  countryCode: z.string().trim().length(2).nullable(),
  ...statedConstraint
});

export const availabilityConstraintSchema = z.object({
  earliestStart: z.iso.date().nullable(),
  latestStart: z.iso.date().nullable(),
  ...statedConstraint
});

export const jobConstraintsSchema = z.object({
  graduation: graduationConstraintSchema.nullable(),
  authorization: authorizationConstraintSchema.nullable(),
  sponsorship: sponsorshipConstraintSchema.nullable(),
  availability: availabilityConstraintSchema.nullable()
});

export const jobPostingSchema = z.object({
  id: z.string().uuid(),
  companyName: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  employmentType: employmentTypeSchema,
  status: jobPostingStatusSchema,
  source: jobSourceSchema,
  snapshot: jobSnapshotSchema,
  locations: z.array(jobLocationSchema),
  compensation: jobCompensationSchema.nullable(),
  requirements: z.array(jobRequirementSchema),
  technologies: z.array(jobTechnologySchema),
  constraints: jobConstraintsSchema,
  publication: postingPublicationSchema.nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});

/** The list projection the Overview and Jobs tables read. */
export const jobSummarySchema = z.object({
  id: z.string().uuid(),
  companyName: z.string().min(1),
  title: z.string().min(1),
  primaryLocation: z.string().min(1),
  /** Distinct countries the posting states; empty when it states none. */
  countryCodes: z.array(z.string().length(2)).optional(),
  /** Comparable USD per hour (see WORK_HOURS_PER_YEAR); null without a USD figure. */
  hourlyUsdPay: z.number().nonnegative().nullable().optional(),
  employmentType: employmentTypeSchema,
  applicationType: applicationTypeSchema,
  sourceUrl: z.url(),
  status: jobPostingStatusSchema,
  hardRequirementCount: z.number().int().nonnegative(),
  preferredRequirementCount: z.number().int().nonnegative(),
  publication: postingPublicationSchema.nullable().optional(),
  createdAt: z.iso.datetime()
});

/**
 * Company and title are supplied rather than guessed. Pasted postings do not
 * carry reliable structure, and inventing an employer name would breach the
 * project's truth invariant for a field a person can read off the page.
 */
export const jobIngestionInputSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(120).max(200_000),
  sourceUrl: z.url(),
  externalApplicationUrl: z.url().nullable().optional(),
  companyCareersUrl: z.url().nullable().optional(),
  publication: postingPublicationSchema.nullable().optional()
});

export type TextSpan = z.infer<typeof textSpanSchema>;
export type ApplicationType = z.infer<typeof applicationTypeSchema>;
export type EmploymentType = z.infer<typeof employmentTypeSchema>;
export type JobWorkMode = z.infer<typeof jobWorkModeSchema>;
export type CompensationPeriod = z.infer<typeof compensationPeriodSchema>;
export type RequirementCategory = z.infer<typeof requirementCategorySchema>;
export type RequirementSubject = z.infer<typeof requirementSubjectSchema>;
export type ExtractionMethod = z.infer<typeof extractionMethodSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type JobPostingStatus = z.infer<typeof jobPostingStatusSchema>;
export type JobSource = z.infer<typeof jobSourceSchema>;
export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;
export type JobRequirement = z.infer<typeof jobRequirementSchema>;
export type JobTechnology = z.infer<typeof jobTechnologySchema>;
export type JobLocation = z.infer<typeof jobLocationSchema>;
export type JobCompensation = z.infer<typeof jobCompensationSchema>;
export type GraduationConstraint = z.infer<typeof graduationConstraintSchema>;
export type AuthorizationConstraint = z.infer<typeof authorizationConstraintSchema>;
export type SponsorshipConstraint = z.infer<typeof sponsorshipConstraintSchema>;
export type AvailabilityConstraint = z.infer<typeof availabilityConstraintSchema>;
export type JobConstraints = z.infer<typeof jobConstraintsSchema>;
export type JobPosting = z.infer<typeof jobPostingSchema>;
export type JobSummary = z.infer<typeof jobSummarySchema>;
export type JobIngestionInput = z.infer<typeof jobIngestionInputSchema>;

export function verifyTextSpan(normalizedText: string, span: TextSpan): boolean {
  return span.end <= normalizedText.length && normalizedText.slice(span.start, span.end) === span.excerpt;
}

export function normalizeTechnologyKey(label: string): string {
  return label.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
