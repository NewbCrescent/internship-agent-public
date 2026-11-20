import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { getDatabase } from "./database";
import { saveCandidate, saveCandidatePreferences } from "./candidate-repository";
import { reconcileProjectEvidence } from "./evidence-repository";
import { completeGitHubRepositorySync, registerGitHubRepository } from "./github-repository";
import { persistNormalizedPosting } from "./job-posting-repository";
import { createResumeEntry, listResumeEntries } from "./resume-entry-repository";

export const LOCAL_CANDIDATE_ID = "local-candidate";

export function seedDevelopmentData(database: DatabaseSync = getDatabase()): void {
  saveCandidate(database, LOCAL_CANDIDATE_ID, {
    fullName: "Jordan Rivera",
    preferredName: "Jordan",
    email: "jordan@example.test",
    school: "Example State University",
    degree: "B.S. Computer Science",
    graduationDate: "2027-05-15",
    githubUrl: "https://github.com/example-candidate"
  });
  saveCandidatePreferences(database, LOCAL_CANDIDATE_ID, {
    roleTypes: ["Software Engineering", "Machine Learning Engineering"],
    locations: ["San Francisco, CA", "Seattle, WA"],
    workModes: ["hybrid", "onsite"],
    industries: ["Developer tools", "Infrastructure"]
  });
  seedDevelopmentResume(database);
  seedDevelopmentPosting(database);
}

/** Fictional, candidate-typed resume entries; seeded once per database. */
function seedDevelopmentResume(database: DatabaseSync): void {
  if (listResumeEntries(database, LOCAL_CANDIDATE_ID).length > 0) return;
  const entry = (section: "experience" | "project" | "skills", content: {
    title: string; role?: string; location?: string; dateText?: string; bullets: string[];
  }) => createResumeEntry(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    section,
    content: {
      title: content.title,
      role: content.role ?? null,
      linkLabel: null,
      linkUrl: null,
      location: content.location ?? null,
      dateText: content.dateText ?? null,
      bullets: content.bullets
    },
    source: { kind: "user" },
    reviewStatus: "APPROVED"
  });
  entry("experience", {
    title: "Example Robotics Lab",
    role: "Software Engineering Intern",
    location: "Example City, CA",
    dateText: "2026",
    bullets: ["Built Python data services for lab experiment tracking."]
  });
  entry("project", {
    title: "Local Evidence Demo",
    location: "Example City, CA",
    dateText: "2026",
    bullets: ["Built a local-first internship workflow demo in TypeScript."]
  });
  entry("skills", { title: "Languages", bullets: ["Python", "TypeScript"] });
}

export function seedBrowserEvidenceData(database: DatabaseSync = getDatabase()): void {
  seedDevelopmentData(database);
  const repository = registerGitHubRepository(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    owner: "example-candidate",
    name: "local-evidence-demo",
    url: "https://github.com/example-candidate/local-evidence-demo",
    defaultBranch: "main",
    description: "A fictional local-first internship workflow demo.",
    observedHeadSha: "1111111111111111111111111111111111111111"
  });
  reconcileProjectEvidence(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    repositoryId: repository.id,
    name: "local-evidence-demo",
    summary: "A fictional local-first internship workflow demo.",
    fullSnapshot: true,
    affectedPaths: ["README.md", "package.json"],
    claims: [
      {
        kind: "project",
        normalizedKey: "summary",
        text: "A fictional local-first internship workflow demo.",
        evidenceFingerprint: "fixture-project-v1",
        evidence: [{
          kind: "readme",
          commitSha: "1111111111111111111111111111111111111111",
          path: "README.md",
          startLine: 3,
          endLine: 3,
          sourceUrl: "https://github.com/example-candidate/local-evidence-demo/blob/1111111111111111111111111111111111111111/README.md#L3",
          excerpt: "A fictional local-first internship workflow demo.",
          excerptHash: "fixture-readme-v1"
        }]
      },
      {
        kind: "technology",
        normalizedKey: "dependency:typescript",
        text: "Project declares typescript as a dependency.",
        evidenceFingerprint: "fixture-typescript-v1",
        evidence: [{
          kind: "manifest",
          commitSha: "1111111111111111111111111111111111111111",
          path: "package.json",
          startLine: 5,
          endLine: 5,
          sourceUrl: "https://github.com/example-candidate/local-evidence-demo/blob/1111111111111111111111111111111111111111/package.json#L5",
          excerpt: "\"typescript\": \"^5\"",
          excerptHash: "fixture-package-v1"
        }]
      }
    ]
  });
  completeGitHubRepositorySync(database, repository.id, "1111111111111111111111111111111111111111", [
    {
      repositoryId: repository.id,
      path: "README.md",
      blobSha: "readme-fixture",
      contentHash: "readme-content-fixture",
      size: 58,
      kind: "readme",
      lastSeenSha: "1111111111111111111111111111111111111111"
    },
    {
      repositoryId: repository.id,
      path: "package.json",
      blobSha: "package-fixture",
      contentHash: "package-content-fixture",
      size: 96,
      kind: "manifest",
      lastSeenSha: "1111111111111111111111111111111111111111"
    }
  ]);
}

/**
 * One fictional posting, normalized through the same tables real ingestion
 * writes to. The text is invented; no real employer's wording is checked in.
 */
function seedDevelopmentPosting(database: DatabaseSync): void {
  const normalizedText = [
    "Software Engineering Intern - Northstar Systems",
    "Location: Seattle, WA",
    "",
    "Northstar Systems builds fictional developer infrastructure for this project's local demo.",
    "",
    "Requirements:",
    "- Must be enrolled in a Bachelor's degree program in Computer Science or a related field",
    "- Experience with Python or TypeScript",
    "- Available to start in June 2027",
    "",
    "Preferred qualifications:",
    "- Familiarity with Docker is a plus",
    "- Exposure to distributed systems preferred",
    "",
    "Compensation: $45 - $60 per hour.",
    "Applicants must be legally authorized to work in the United States."
  ].join("\n");

  persistNormalizedPosting(database, {
    companyName: "Northstar Systems",
    title: "Software Engineering Intern",
    employmentType: "INTERNSHIP",
    applicationType: "UNKNOWN",
    sourceUrl: "https://example.test/internships/northstar-software-engineering",
    externalApplicationUrl: null,
    companyCareersUrl: null,
    contentHash: createHash("sha256").update(normalizedText).digest("hex"),
    normalizedText,
    locations: [{
      raw: "Seattle, WA",
      city: "Seattle",
      region: "WA",
      countryCode: "US",
      workMode: "UNSPECIFIED",
      span: spanOf(normalizedText, "Seattle, WA")
    }],
    compensation: {
      raw: "$45 - $60 per hour",
      minimum: 45,
      maximum: 60,
      currency: "USD",
      period: "HOUR",
      span: spanOf(normalizedText, "$45 - $60 per hour")
    },
    requirements: [
      requirement(normalizedText, "Must be enrolled in a Bachelor's degree program in Computer Science or a related field", "HARD", "DEGREE", 0.9),
      requirement(normalizedText, "Experience with Python or TypeScript", "HARD", "SKILL", 0.7),
      requirement(normalizedText, "Available to start in June 2027", "HARD", "AVAILABILITY", 0.7),
      requirement(normalizedText, "Familiarity with Docker is a plus", "PREFERRED", "SKILL", 0.9),
      requirement(normalizedText, "Exposure to distributed systems preferred", "PREFERRED", "SKILL", 0.9)
    ],
    technologies: [
      technology(normalizedText, "Python", "python"),
      technology(normalizedText, "TypeScript", "typescript"),
      technology(normalizedText, "Docker", "docker")
    ],
    constraints: {
      graduation: null,
      authorization: {
        requiresExistingAuthorization: true,
        countryCode: "US",
        raw: "Applicants must be legally authorized to work in the United States",
        extraction: "DETERMINISTIC",
        assertion: "STATED",
        span: spanOf(normalizedText, "Applicants must be legally authorized to work in the United States")
      },
      sponsorship: null,
      availability: null
    }
  });
}

function spanOf(normalizedText: string, excerpt: string) {
  const start = normalizedText.indexOf(excerpt);
  if (start < 0) throw new Error(`Seed excerpt is not present in the seeded posting: ${excerpt}`);
  return { start, end: start + excerpt.length, excerpt };
}

function requirement(
  normalizedText: string,
  text: string,
  category: "HARD" | "PREFERRED",
  subject: "DEGREE" | "SKILL" | "AVAILABILITY",
  confidence: number
) {
  return {
    text,
    category,
    subject,
    extraction: "DETERMINISTIC" as const,
    assertion: "STATED" as const,
    confidence,
    span: spanOf(normalizedText, text)
  };
}

function technology(normalizedText: string, label: string, normalizedKey: string) {
  return {
    label,
    normalizedKey,
    extraction: "DETERMINISTIC" as const,
    span: spanOf(normalizedText, label)
  };
}
