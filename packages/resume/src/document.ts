import type {
  CandidateProfileInput,
  ResumeDocument,
  ResumeDocumentEntry,
  ResumeEntry
} from "@internship-agent/domain";
import { resumeDocumentSchema } from "@internship-agent/domain";

/**
 * Freezes the candidate's approved entries and profile header into the
 * structured resume a variant prints from. Entries keep the caller's order
 * (section, then the candidate's position) and their exact text: selection
 * and ordering only, never rewording.
 */
export function buildResumeDocument(profile: CandidateProfileInput, entries: ResumeEntry[]): ResumeDocument {
  const approved = entries.filter((entry) => entry.archivedAt === null && entry.onResume !== false && entry.current.reviewStatus === "APPROVED");
  const frozen = (section: ResumeEntry["section"]): ResumeDocumentEntry[] =>
    approved.filter((entry) => entry.section === section).map((entry) => ({
      entryId: entry.id,
      revisionId: entry.current.id,
      title: entry.current.title,
      role: entry.current.role,
      linkLabel: entry.current.linkLabel,
      linkUrl: entry.current.linkUrl,
      location: entry.current.location,
      dateText: entry.current.dateText,
      bullets: [...entry.current.bullets]
    }));
  const hasEducation = Boolean(profile.school || profile.degree);
  return resumeDocumentSchema.parse({
    header: {
      fullName: profile.fullName,
      email: profile.email ?? null,
      phone: profile.phone ?? null,
      githubUrl: profile.githubUrl ?? null,
      linkedinUrl: profile.linkedinUrl ?? null,
      portfolioUrl: profile.portfolioUrl ?? null
    },
    education: hasEducation
      ? {
          school: profile.school ?? null,
          degree: profile.degree ?? null,
          gpa: profile.gpa ?? null,
          graduationDate: profile.graduationDate ?? null
        }
      : null,
    experience: frozen("experience"),
    projects: frozen("project"),
    skills: frozen("skills")
  });
}

export const RESUME_SECTION_TITLES = {
  education: "Education",
  experience: "Professional Experience",
  projects: "Projects",
  skills: "Technical Skills"
} as const;

/** Readable markdown snapshot of the structured resume. */
export function renderResumeDocumentMarkdown(document: ResumeDocument): string {
  const lines = [`# ${document.header.fullName}`, ""];
  const contact = contactParts(document.header).map((part) => (part.url ? `[${part.label}](${part.url})` : part.label));
  if (contact.length > 0) lines.push(contact.join(" • "), "");
  if (document.education) {
    lines.push(`## ${RESUME_SECTION_TITLES.education}`, `- ${educationLine(document.education, (text) => `**${text}**`)}`, "");
  }
  const entrySection = (title: string, entries: ResumeDocumentEntry[]) => {
    if (entries.length === 0) return;
    lines.push(`## ${title}`);
    for (const entry of entries) {
      const name = entry.role ? `**${entry.title}** | ${entry.role}` : `**${entry.title}**`;
      const link = entry.linkUrl ? ` ([${entry.linkLabel ?? entry.linkUrl}](${entry.linkUrl}))` : "";
      const place = [entry.location, entry.dateText].filter(Boolean).join(" ");
      lines.push(`### ${name}${link}${place ? ` — ${place}` : ""}`);
      for (const bullet of entry.bullets) lines.push(`- ${bullet}`);
    }
    lines.push("");
  };
  entrySection(RESUME_SECTION_TITLES.experience, document.experience);
  entrySection(RESUME_SECTION_TITLES.projects, document.projects);
  if (document.skills.length > 0) {
    lines.push(`## ${RESUME_SECTION_TITLES.skills}`);
    for (const group of document.skills) lines.push(`- **${group.title}:** ${group.bullets.join(", ")}`);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

export type ContactPart = { label: string; url: string | null };

export function contactParts(header: {
  email?: string | null;
  phone?: string | null;
  githubUrl?: string | null;
  linkedinUrl?: string | null;
  portfolioUrl?: string | null;
}): ContactPart[] {
  const parts: ContactPart[] = [];
  if (header.email) parts.push({ label: header.email, url: null });
  if (header.phone) parts.push({ label: header.phone, url: null });
  if (header.githubUrl) parts.push({ label: "GitHub", url: header.githubUrl });
  if (header.linkedinUrl) parts.push({ label: "LinkedIn", url: header.linkedinUrl });
  if (header.portfolioUrl) parts.push({ label: siteLabel(header.portfolioUrl), url: header.portfolioUrl });
  return parts;
}

/** "School — Degree | GPA: 3.691 (Expected May 2028)", with the school styled by the caller. */
export function educationLine(
  education: NonNullable<ResumeDocument["education"]>,
  styleSchool: (text: string) => string
): string {
  const school = education.school ? styleSchool(education.school) : null;
  const base = [school, education.degree].filter(Boolean).join(" — ");
  const gpa = education.gpa ? ` | GPA: ${education.gpa}` : "";
  const graduation = education.graduationDate ? ` (Expected ${formatMonthYear(education.graduationDate)})` : "";
  return `${base}${gpa}${graduation}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

export function formatMonthYear(isoDate: string): string {
  const [year, month] = isoDate.split("-");
  const name = MONTHS[Number(month) - 1];
  return name && year ? `${name} ${year}` : isoDate;
}

export function siteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
