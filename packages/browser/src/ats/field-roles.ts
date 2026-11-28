import type { BrowserField, FieldRole } from "@internship-agent/domain";

type RolePattern = { role: FieldRole; pattern: RegExp };

/**
 * Canonical application form model: every recognized field maps to one
 * semantic role. The `eeo` role covers demographic and equal-opportunity
 * questions, which are sensitive by construction — they pause unless the
 * candidate's saved voluntary self-identification answer matches exactly one
 * offered option (ats/self-identification.ts), and answers given in-session
 * are never remembered. A pronoun question is not `eeo`, even worded "gender
 * pronouns": it takes the saved pronouns answer (Track 82).
 */
const ROLE_PATTERNS: RolePattern[] = [
  { role: "email", pattern: /\b(e-?mail|email address)\b/i },
  { role: "phone", pattern: /\b(phone|mobile|telephone|cell)\b/i },
  { role: "resume", pattern: /\b(resume|cv|curriculum vitae)\b|r[eé]sum[eé]|add resume|attach resume/i },
  { role: "cover", pattern: /\bcover ?letter\b/i },
  { role: "linkedin", pattern: /linked ?in/i },
  { role: "github", pattern: /github/i },
  { role: "portfolio", pattern: /\b(portfolio|website|personal site)\b/i },
  { role: "work-auth", pattern: /\b(authoriz|eligible to work|legally able to work)\b/i },
  { role: "sponsorship", pattern: /\bsponsor(ship)?\b/i },
  { role: "start-date", pattern: /\b(start date|available|availability|begin work)\b/i },
  { role: "location", pattern: /\b(location|city|address|where are you|relocat)\b/i },
  { role: "name", pattern: /\b(full name|first name|last name|preferred name|your name)\b/i },
  {
    role: "eeo",
    pattern: /\b(gender|race|racial|ethnicity|ethnic|veterans?|disabilit(?:y|ies)|sexual orientation|transgender|age over|hispanic|latin[oaxe]|lgbt\w*|equal opportunity|voluntary self-identification|demographic|sex(?!\s*offend))\b/i
  }
];

export function classifyFieldRole(field: BrowserField): FieldRole {
  if (field.kind === "email") return "email";
  if (field.kind === "tel") return "phone";
  if (field.kind === "file") return classifyUploadRole(field.label, field.id);
  // A pronoun question is the saved pronouns answer's (question-mapper.ts `pronouns`), not self-identification, even
  // worded "gender pronouns" (Strava, Track 82); "gender identity and pronouns" still names gender and stays eeo.
  const label = field.label.replace(/\bgender\s+pronouns?\b/gi, "pronouns");
  for (const { role, pattern } of ROLE_PATTERNS) {
    if (pattern.test(label)) return role;
  }
  return field.kind === "unknown" ? "unknown" : "custom";
}

/**
 * File fields are routed by what they ask for. Only a field that names a
 * resume or CV receives the resume and only a transcript field receives the
 * transcript; a cover letter or an unlabeled attachment is the candidate's
 * call, so it never silently receives the resume.
 */
export function classifyUploadRole(label: string, fieldId?: string): "resume" | "transcript" | "cover" | "document" {
  if (/\btranscripts?\b|\bacademic record\b/i.test(label) || /\btranscript\b/i.test(fieldId ?? "")) return "transcript";
  if (/\bcover ?letter\b/i.test(label) || /\bcover/i.test(fieldId ?? "")) return "cover";
  if (/\b(resume|cv|curriculum vitae)\b|r[eé]sum[eé]|add resume|attach resume/i.test(label)) return "resume";
  if (fieldId && (/^file-input-0$/i.test(fieldId) || /\b(resume|cv)\b/i.test(fieldId))) return "resume";
  return "document";
}

/** True when the form asks the candidate to upload a transcript. */
export function hasTranscriptField(fields: BrowserField[]): boolean {
  return fields.some((field) => field.kind === "file" && classifyUploadRole(field.label, field.id) === "transcript");
}

/** Sensitive roles pause unless the candidate's saved voluntary self-identification answer matches exactly one offered option (ats/self-identification.ts); answers given in-session are never remembered. */
export function isSensitiveRole(role: FieldRole): boolean {
  return role === "eeo";
}
