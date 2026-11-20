import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { expect } from "vitest";

import {
  createDatabase,
  LOCAL_CANDIDATE_ID,
  listProjectEvidenceProfiles,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim,
  saveCandidateFact,
  seedDevelopmentData
} from "@internship-agent/db";
import type { BaseResume, BrowserField, BrowserRun, CandidateDocument } from "@internship-agent/domain";
import type { BrowserPage, RawControl } from "@internship-agent/browser";
import {
  approveApplication,
  approveRunSubmission,
  approveRunSubmissionAutomatically,
  confirmRunAts,
  evaluateAndPersistMatch,
  prepareApplication,
  startBrowserRun,
  storeBaseResume,
  storeCandidateDocument,
  submitBrowserRun,
  type ApplicationRecordWriter
} from "@internship-agent/agent";

/**
 * Shared helpers for the application-record suites: disposable workspaces,
 * an in-memory page, the fictional seeded candidate, and minimal valid PDFs.
 * Nothing here reads the real profile, launches a browser, or uses the network.
 */

/** A valid uncompressed PDF with `pages` blank Letter pages and a correct xref table. */
export function minimalPdf(pages: number): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ")}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>")
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** A record renderer that captures the HTML and writes a one-page PDF; never launches Chromium. */
export function fakeRenderer(captured: string[]) {
  return async (html: string, path: string) => {
    captured.push(html);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, minimalPdf(1));
    return { pages: 1 };
  };
}

/** The resume renderer the runs use: writes a one-page PDF where the upload expects it. */
export async function resumeRenderer(_html: string, path: string): Promise<{ pages: number }> {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, minimalPdf(1));
  return { pages: 1 };
}

const temporaryDirectories: string[] = [];

export function cleanupTemporaryDirectories(): void {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

export function disposableDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-record-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A workspace directory with its database at the location the demo profile uses for it. */
export function disposableWorkspace(): { dataDir: string; database: DatabaseSync } {
  const dataDir = disposableDataDir();
  return { dataDir, database: createDatabase(join(dataDir, "internship-agent.sqlite")) };
}

/** In-memory stand-in for a page: records fills, never touches a browser. */
export function fakePage(overrides: {
  controls?: RawControl[];
  confirmation?: string | null;
  url?: string;
  title?: string;
  body?: string;
} = {}): BrowserPage & { filled: Map<string, string>; uploads: Map<string, string> } {
  const filled = new Map<string, string>();
  const uploads = new Map<string, string>();
  const confirmation = overrides.confirmation ?? "Thank you! Your application was received.";
  let submitted = false;
  return {
    filled,
    uploads,
    url: () => overrides.url ?? "https://app.joinhandshake.com/apply/900001",
    title: async () => overrides.title ?? "Handshake application",
    collectControls: async () => overrides.controls ?? [
      { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
      { tag: "input", type: "text", id: "q2", label: "Favorite color?", required: false },
      { tag: "button", label: "Submit application" }
    ],
    bodyText: async () => {
      if (submitted) return confirmation;
      return overrides.body ?? "Please fix the errors below.";
    },
    fillField: async (field: BrowserField, value: string) => {
      filled.set(field.id, value);
    },
    chooseOption: async (field: BrowserField, option: string) => {
      filled.set(field.id, option);
    },
    setChecked: async (field: BrowserField, checked: boolean) => {
      filled.set(field.id, String(checked));
    },
    uploadFile: async (field: BrowserField, path: string) => {
      uploads.set(field.id, path);
    },
    clickSubmit: async () => {
      submitted = true;
    },
    screenshot: async () => {},
    close: async () => {}
  };
}

function saveFact(
  database: DatabaseSync,
  key: "authorized_to_work" | "requires_sponsorship" | "available_start_date",
  scope: { kind: "country"; code: string } | { kind: "global" },
  value: boolean | string
) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    key,
    scope,
    value,
    source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." },
    confidence: 1,
    rememberedAt: "2026-09-22T12:00:00.000Z"
  });
}

export function approvedJobId(database: DatabaseSync, stopAt: "approved" | "qualified" | "ingested" = "approved"): string {
  seedDevelopmentData(database);
  // The automatic pipeline runs only on AI labels; the seed's rule labels stand in for them here.
  database.prepare("UPDATE job_requirements SET extraction = 'MODEL'").run();
  saveFact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
  saveFact(database, "requires_sponsorship", { kind: "country", code: "US" }, false);
  saveFact(database, "available_start_date", { kind: "global" }, "2027-06-01");

  const repository = registerGitHubRepository(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    owner: "example",
    name: "evidence-demo",
    url: "https://github.com/example/evidence-demo",
    defaultBranch: "main",
    description: "Fixture evidence.",
    observedHeadSha: "sha-fixture"
  });
  const sha = "sha-fixture";
  reconcileProjectEvidence(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    repositoryId: repository.id,
    name: "evidence-demo",
    summary: "Fixture project.",
    fullSnapshot: true,
    affectedPaths: ["README.md"],
    claims: [{
      kind: "technology",
      normalizedKey: "python",
      text: "Shipped Python services in production.",
      evidenceFingerprint: "tech-v1",
      evidence: [{
        kind: "readme",
        commitSha: sha,
        path: "README.md",
        startLine: 2,
        endLine: 2,
        sourceUrl: `https://github.com/example/evidence-demo/blob/${sha}/README.md#L2`,
        excerpt: "Python services in production.",
        excerptHash: "tech-excerpt-v1"
      }]
    }]
  });
  const tech = listProjectEvidenceProfiles(database, LOCAL_CANDIDATE_ID)[0].claims[0];
  expect(reviewEvidenceClaim(database, { claimId: tech.id, decision: "ALLOWED" })).toBe(true);

  const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
  if (stopAt === "ingested") return row.id;
  evaluateAndPersistMatch(row.id, { database, candidateId: LOCAL_CANDIDATE_ID });
  if (stopAt === "qualified") return row.id;
  prepareApplication(row.id, { database });
  approveApplication(row.id, { database });
  return row.id;
}

export function setApplicationType(database: DatabaseSync, jobId: string, type: "HANDSHAKE_INTERNAL" | "EXTERNAL_ATS") {
  database.prepare("UPDATE jobs SET application_type = ? WHERE id = ?").run(type, jobId);
}

/** The default (2028) and alternate-profile (2029) graduation answers. */
export function graduationFacts(database: DatabaseSync, alternate = true) {
  for (const [scope, value] of [
    [{ kind: "global" }, "2028-05-15"],
    ...(alternate ? [[{ kind: "application_channel", channel: "handshake_internal" }, "2029-05-15"]] as const : [])
  ] as const) {
    saveCandidateFact(database, {
      candidateId: LOCAL_CANDIDATE_ID,
      key: "graduation_date",
      scope,
      value,
      source: "user",
      sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." },
      confidence: 1,
      rememberedAt: "2026-09-22T12:00:00.000Z"
    });
  }
}

export const FILE_CONTROLS: RawControl[] = [
  { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
  { tag: "input", type: "file", id: "resume", label: "Resume", required: true },
  { tag: "button", label: "Submit application" }
];

export const TRANSCRIPT_CONTROLS: RawControl[] = [
  { tag: "input", type: "text", id: "grad", label: "What is your expected graduation date?", required: true },
  { tag: "input", type: "file", id: "resume", label: "Resume", required: true },
  { tag: "input", type: "file", id: "transcript", label: "Unofficial transcript", required: true },
  { tag: "button", label: "Submit application" }
];

export const EXTERNAL_URL = "https://boards.greenhouse.io/example/jobs/2";

export const POLICY_BASIS = ["Summer 2027 term, software or adjacent role, US location;", "every answer came from your saved facts and materials."];

/**
 * An approved external (Greenhouse) application with both graduation answers
 * and a stored two-page transcript, filled and submitted through fake pages.
 * `auto` approves it with the auto-submit policy instead of the candidate;
 * `baseResumes` stores the candidate's uploaded resumes before the run.
 */
export async function submitExternal(input: {
  database: DatabaseSync;
  dataDir: string;
  controls: RawControl[];
  auto?: boolean;
  applicationRecord?: ApplicationRecordWriter | null;
  baseResumes?: Array<{ channel: "default" | "handshake_internal"; label: string; originalName: string; bytes: Uint8Array }>;
}): Promise<{ jobId: string; runId: string; submitted: BrowserRun; transcript: CandidateDocument; baseResumes: BaseResume[] }> {
  const { database, dataDir, controls } = input;
  const jobId = approvedJobId(database);
  const baseResumes = (input.baseResumes ?? []).map((resume) => storeBaseResume(resume, { database, dataDir }));
  setApplicationType(database, jobId, "EXTERNAL_ATS");
  graduationFacts(database);
  const transcript = storeCandidateDocument({ kind: "transcript", label: "Transcript", originalName: "t.pdf", bytes: minimalPdf(2) }, { database, dataDir });
  const page = () => fakePage({ controls, url: EXTERNAL_URL, title: "Example" });
  const started = await startBrowserRun(jobId, EXTERNAL_URL, { database, dataDir, renderPdf: resumeRenderer, openPage: async () => page() });
  const runId = started.run.id;
  confirmRunAts(runId, "greenhouse", { database });
  if (input.auto) {
    const manual = process.env.INTERNSHIP_AGENT_MANUAL_ONLY;
    delete process.env.INTERNSHIP_AGENT_MANUAL_ONLY;
    try {
      approveRunSubmissionAutomatically(runId, POLICY_BASIS, { database });
    } finally {
      if (manual !== undefined) process.env.INTERNSHIP_AGENT_MANUAL_ONLY = manual;
    }
  } else {
    approveRunSubmission(runId, undefined, { database });
  }
  const submitted = await submitBrowserRun(runId, {
    database, dataDir, renderPdf: resumeRenderer, openPage: async () => page(), applicationRecord: input.applicationRecord
  });
  return { jobId, runId, submitted, transcript, baseResumes };
}
