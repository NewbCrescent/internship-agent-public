import { z } from "zod";

/**
 * Structured resume content. Entries are candidate-authored: typed by the
 * candidate, or transcribed verbatim from the candidate's own base resume and
 * held as PENDING until the candidate approves them. The writer selects and
 * orders approved entries; it never rewrites them.
 *
 * Skills share the entry shape: `title` is the group label ("Languages") and
 * `bullets` are its items.
 */
export const resumeSectionSchema = z.enum(["experience", "project", "skills"]);
export const resumeReviewStatusSchema = z.enum(["PENDING", "APPROVED"]);

export const resumeEntrySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({
    kind: z.literal("base_resume"),
    baseResumeId: z.string().uuid(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/)
  })
]);

const optionalDisplay = (max: number) =>
  z.string().trim().max(max).nullable().transform((value) => value || null);

const monthValue = z.string().trim().regex(/^(\d{4}-(0[1-9]|1[0-2]))?$/, "Use a month like 2025-06.").nullable().optional()
  .transform((value) => value || null);

const httpUrl = z.url().refine((value) => /^https?:\/\//i.test(value), "Links must use http or https.");

const resumeEntryContentBase = z.object({
  /** Organization, project name, or skill-group label. */
  title: z.string().trim().min(1).max(160),
  /** Role for experience entries; null for projects and skills. */
  role: optionalDisplay(160),
  linkLabel: optionalDisplay(80),
  linkUrl: httpUrl.nullable(),
  /** Shown exactly as written ("Berkeley, CA", "Remote"). */
  location: optionalDisplay(80),
  /** Shown exactly as written ("2026", "Summer 2025"); never parsed. */
  dateText: optionalDisplay(60),
  bullets: z.array(z.string().trim().min(1).max(400)).max(40),
  /** Application forms' month and year boxes (YYYY-MM), entered by the candidate; never printed. */
  startMonth: monthValue,
  endMonth: monthValue,
  isCurrent: z.boolean().default(false)
});

export const resumeEntryContentSchema = resumeEntryContentBase.refine((entry) => !entry.isCurrent || entry.endMonth === null, { message: "A current role has no end month.", path: ["endMonth"] })
  .refine((entry) => !entry.startMonth || !entry.endMonth || entry.startMonth <= entry.endMonth, { message: "The end month is before the start month.", path: ["endMonth"] });

export const resumeEntryRevisionSchema = resumeEntryContentBase.extend({
  id: z.string().uuid(),
  entryId: z.string().uuid(),
  source: resumeEntrySourceSchema,
  reviewStatus: resumeReviewStatusSchema,
  approvedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  supersededAt: z.iso.datetime().nullable()
});

export const resumeEntrySchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().min(1),
  section: resumeSectionSchema,
  position: z.number().int().nonnegative(),
  archivedAt: z.iso.datetime().nullable(),
  /** Printed on the resume; entries left off remain approved library content. */
  onResume: z.boolean().default(true),
  /** Listed in application work-history sections (experience entries only); independent of the resume. */
  inWorkHistory: z.boolean().default(false),
  createdAt: z.iso.datetime(),
  current: resumeEntryRevisionSchema
});

/** One entry as frozen into a resume snapshot. */
export const resumeDocumentEntrySchema = z.object({
  entryId: z.string().uuid(),
  revisionId: z.string().uuid(),
  title: z.string().min(1).max(160),
  role: z.string().max(160).nullable(),
  linkLabel: z.string().max(80).nullable(),
  linkUrl: z.string().max(2_000).nullable(),
  location: z.string().max(80).nullable(),
  dateText: z.string().max(60).nullable(),
  bullets: z.array(z.string().min(1).max(400))
});

/** The frozen, structured resume a submitted PDF is printed from. */
export const resumeDocumentSchema = z.object({
  header: z.object({
    fullName: z.string().min(1).max(120),
    email: z.string().max(320).nullable(),
    phone: z.string().max(40).nullable(),
    githubUrl: z.string().max(2_000).nullable(),
    linkedinUrl: z.string().max(2_000).nullable(),
    portfolioUrl: z.string().max(2_000).nullable()
  }),
  education: z.object({
    school: z.string().max(160).nullable(),
    degree: z.string().max(160).nullable(),
    gpa: z.string().max(10).nullable(),
    graduationDate: z.iso.date().nullable()
  }).nullable(),
  experience: z.array(resumeDocumentEntrySchema),
  projects: z.array(resumeDocumentEntrySchema),
  skills: z.array(resumeDocumentEntrySchema)
});

/** The heading line an entry asserts; the verifier re-derives it. */
export function resumeEntryHeading(entry: {
  section: ResumeSection;
  title: string;
  role: string | null;
  location: string | null;
  dateText: string | null;
}): string {
  if (entry.section === "skills") return entry.title;
  const name = entry.role ? `${entry.title} | ${entry.role}` : entry.title;
  const place = [entry.location, entry.dateText].filter(Boolean).join(" ");
  return place ? `${name} — ${place}` : name;
}

/** Longest skills line a resume bullet can carry. */
export const RESUME_SKILLS_LINE_MAX = 500;

/** The single assertion a skills entry makes. */
export function resumeSkillsLine(entry: { title: string; bullets: string[] }): string {
  return `${entry.title}: ${entry.bullets.join(", ")}`;
}

export type ResumeSection = z.infer<typeof resumeSectionSchema>;
export type ResumeReviewStatus = z.infer<typeof resumeReviewStatusSchema>;
export type ResumeEntrySource = z.infer<typeof resumeEntrySourceSchema>;
export type ResumeEntryContent = z.infer<typeof resumeEntryContentSchema>;
export type ResumeEntryContentInput = z.input<typeof resumeEntryContentSchema>;
export type ResumeEntryRevision = z.infer<typeof resumeEntryRevisionSchema>;
export type ResumeEntry = z.infer<typeof resumeEntrySchema>;
export type ResumeDocumentEntry = z.infer<typeof resumeDocumentEntrySchema>;
export type ResumeDocument = z.infer<typeof resumeDocumentSchema>;
