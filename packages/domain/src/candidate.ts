import { z } from "zod";

const optionalUrl = z.union([z.url(), z.literal("")]).transform((value) => value || undefined).optional();
const optionalText = (max: number) => z.string().trim().max(max).optional();
const yearText = () => z.union([z.string().trim().regex(/^(19|20)\d{2}$/, "Use a year like 2021."), z.literal("")])
  .transform((value) => value || undefined).optional();

export const candidateProfileInputSchema = z.object({
  fullName: z.string().trim().min(1, "Full name is required").max(120),
  preferredName: optionalText(80),
  email: z.union([z.email(), z.literal("")]).transform((value) => value || undefined).optional(),
  phone: optionalText(40),
  school: optionalText(160),
  degree: optionalText(160),
  graduationDate: z.union([z.iso.date(), z.literal("")]).transform((value) => value || undefined).optional(),
  /** As printed on the candidate's resume, e.g. "3.691". Only the candidate enters it. */
  gpa: z.union([z.string().trim().regex(/^[0-4]\.\d{1,3}$/, "Enter a GPA like 3.691"), z.literal("")])
    .transform((value) => value || undefined)
    .optional(),
  linkedinUrl: optionalUrl,
  githubUrl: optionalUrl,
  portfolioUrl: optionalUrl,
  /** Exactly as on legal documents; entered by the candidate, never split from the full name. */
  legalFirstName: optionalText(80),
  legalLastName: optionalText(80),
  /** Mailing address that application forms ask for. */
  addressLine1: optionalText(160),
  addressLine2: optionalText(160),
  addressCity: optionalText(80),
  addressRegion: optionalText(80),
  addressPostalCode: optionalText(20),
  addressCountry: optionalText(80),
  /** What kind of number the phone is ("Mobile", "Home", "Work"), as forms ask. */
  phoneType: optionalText(30),
  fieldOfStudy: optionalText(120),
  /** Month education began, YYYY-MM. */
  educationStartMonth: z.union([z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month like 2024-08."), z.literal("")])
    .transform((value) => value || undefined).optional(),
  /** High school, for application education sections; never printed on the resume. */
  highSchoolName: optionalText(160),
  highSchoolStartYear: yearText(),
  highSchoolEndYear: yearText()
});

export const candidateSchema = candidateProfileInputSchema.extend({
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** The high school's place and where its details came from (migration 0035); not on the profile page, so a profile save keeps them. */
  highSchoolCity: z.string().max(80).optional(),
  highSchoolRegion: z.string().max(80).optional(),
  highSchoolPostalCode: z.string().max(20).optional(),
  highSchoolSource: z.string().max(300).optional()
});

/** The high school's details the candidate stated outside the profile page (pnpm profile:facts' highSchool file). */
export const highSchoolDetailsSchema = z.object({
  city: z.string().trim().min(1).max(80).optional(),
  region: z.string().trim().min(1).max(80).optional(),
  postalCode: z.string().trim().min(1).max(20).optional(),
  startYear: z.string().trim().regex(/^(19|20)\d{2}$/, "Use a year like 2021.").optional(),
  endYear: z.string().trim().regex(/^(19|20)\d{2}$/, "Use a year like 2021.").optional()
}).strict();

export const workModeSchema = z.enum(["remote", "hybrid", "onsite"]);

export const candidatePreferenceInputSchema = z.object({
  roleTypes: z.array(z.string().trim().min(1).max(80)).max(20),
  locations: z.array(z.string().trim().min(1).max(120)).max(30),
  workModes: z.array(workModeSchema).max(3),
  industries: z.array(z.string().trim().min(1).max(80)).max(20),
  excludeGraduateOnlyInternships: z.boolean().default(false)
});

export const candidatePreferenceSchema = candidatePreferenceInputSchema.extend({
  candidateId: z.string().min(1),
  updatedAt: z.iso.datetime()
});

export type CandidateProfileInput = z.infer<typeof candidateProfileInputSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type HighSchoolDetails = z.infer<typeof highSchoolDetailsSchema>;
export type CandidatePreferenceInput = z.input<typeof candidatePreferenceInputSchema>;
export type CandidatePreference = z.infer<typeof candidatePreferenceSchema>;
export type WorkMode = z.infer<typeof workModeSchema>;
