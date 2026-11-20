import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { getJobPosting, listApplicationEvents, updateBrowserRun } from "@internship-agent/db";
import {
  applicationRecordPdfPath,
  candidateDocumentFilePath,
  countPdfPages,
  submittedFieldLabelsPath,
  type RawControl
} from "@internship-agent/browser";
import {
  acquirePipelineLock,
  prepareApplication,
  recordManualApplication,
  regenerateApplicationRecords,
  renderApplicationRecordHtml,
  saveApplicationRecord,
  saveApplicationRecordQuietly,
  type ApplicationRecord
} from "@internship-agent/agent";

import {
  approvedJobId,
  cleanupTemporaryDirectories,
  disposableDataDir,
  disposableWorkspace,
  EXTERNAL_URL,
  fakeRenderer,
  FILE_CONTROLS,
  minimalPdf,
  submitExternal,
  TRANSCRIPT_CONTROLS
} from "./application-record-fixture";

/**
 * Local application records with a stub renderer and temporary workspaces;
 * no Chromium, no network, never the real profile.
 */
afterEach(() => cleanupTemporaryDirectories());

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SAVED = "Application record saved locally.";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const escapeHtml = (text: string) => text
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const mode = (path: string) => statSync(path).mode & 0o777;

function details(database: DatabaseSync, jobId: string): string[] {
  return listApplicationEvents(database, jobId).map((event) => event.detail ?? "");
}

function recordDetails(database: DatabaseSync, jobId: string): string[] {
  return details(database, jobId).filter((detail) => detail.startsWith("Application record"));
}

function leftovers(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).filter((name) => /\.tmp$|\.render\.pdf$/.test(name)) : [];
}

function writerWith(captured: string[]) {
  return (input: Parameters<typeof saveApplicationRecordQuietly>[0]) => saveApplicationRecordQuietly(input, { renderPdf: fakeRenderer(captured) });
}

function runCli(dataDir: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "packages/agent/scripts/application-record.ts", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, INTERNSHIP_AGENT_DATA_DIR: dataDir },
    encoding: "utf8"
  });
}

describe("application records after submission", () => {
  it("records a transcript application the candidate approved: fields, uploads, pages, and a private file", async () => {
    const { dataDir, database } = disposableWorkspace();
    const captured: string[] = [];
    const { jobId, runId, submitted, transcript } = await submitExternal({ database, dataDir, controls: TRANSCRIPT_CONTROLS, applicationRecord: writerWith(captured) });
    expect(submitted.status).toBe("submitted");

    const recordPath = applicationRecordPdfPath(dataDir, jobId);
    expect(existsSync(recordPath)).toBe(true);
    expect(mode(recordPath)).toBe(0o600);
    const bytes = readFileSync(recordPath);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(countPdfPages(bytes)).toBe(4);

    const posting = getJobPosting(database, jobId)!;
    expect(captured).toHaveLength(1);
    const html = captured[0]!;
    expect(html).toContain(escapeHtml(posting.companyName));
    expect(html).toContain(escapeHtml(posting.title));
    expect(html).toContain(escapeHtml(posting.source.sourceUrl));
    expect(html).toContain(EXTERNAL_URL);
    expect(html).toContain("Approved by you");
    expect(html).not.toContain("auto-submit policy");
    expect(html).toContain("Transcript alternate profile");
    expect(html).toContain("2029-05-15");
    expect(html).toContain("What is your expected graduation date?");
    expect(html).toContain("Unofficial transcript");
    expect(html).toMatch(/resume-[0-9a-f-]+-graduating-2029-05-15\.pdf/);
    expect(html).toContain(sha256(minimalPdf(1)));
    expect(html).toContain(transcript.sha256);
    expect(html).toContain("Appended after this record.");
    expect(html).toContain("Thank you! Your application was received.");
    expect(html).toContain(escapeHtml(posting.snapshot.normalizedText.slice(0, 60)));
    expect(html).not.toContain("Italic labels were not recorded");

    const sidecar = submittedFieldLabelsPath(dataDir, jobId);
    expect(mode(sidecar)).toBe(0o600);
    expect((JSON.parse(readFileSync(sidecar, "utf8")) as { runId: string }).runId).toBe(runId);

    expect(recordDetails(database, jobId)).toEqual([SAVED]);
    for (const detail of recordDetails(database, jobId)) {
      expect(detail).not.toContain(dataDir);
      expect(detail).not.toContain(".pdf");
    }
    const files = readdirSync(join(dataDir, "applications", jobId)).sort();
    expect(files.filter((name) => !/^resume-.*\.pdf$/.test(name))).toEqual(["application-record.pdf", "submitted-field-labels.json"]);
    expect(files.some((name) => /^resume-.*\.pdf$/.test(name))).toBe(true);
    database.close();
  });

  it("names the auto-submit policy and its basis, never the candidate, when the policy approved", async () => {
    const { dataDir, database } = disposableWorkspace();
    const captured: string[] = [];
    await submitExternal({ database, dataDir, controls: TRANSCRIPT_CONTROLS, auto: true, applicationRecord: writerWith(captured) });
    const html = captured[0]!;
    expect(html).toContain("Approved automatically by your auto-submit policy");
    expect(html).toContain("Summer 2027 term");
    expect(html).not.toContain("Approved by you");
    database.close();
  });

  it("records the default profile and the standard resume when no transcript was asked", async () => {
    const { dataDir, database } = disposableWorkspace();
    const captured: string[] = [];
    const { submitted } = await submitExternal({ database, dataDir, controls: FILE_CONTROLS, applicationRecord: writerWith(captured) });
    const html = captured[0]!;
    expect(html).toContain("Default profile");
    expect(html).toContain("2028-05-15");
    expect(html).toContain("not asked as a form field");
    expect(html).toContain(`resume-${submitted.variantId}.pdf`);
    expect(html).not.toContain("graduating");
    database.close();
  });

  it("reports the graduation question's full date, not an education end year with the same fact basis", async () => {
    const { dataDir, database } = disposableWorkspace();
    const captured: string[] = [];
    const controls: RawControl[] = [
      { tag: "input", type: "number", id: "end-year--0", label: "End date year", required: true },
      { tag: "input", type: "text", id: "grad", label: "What is your expected graduation date?", required: true },
      { tag: "input", type: "file", id: "resume", label: "Resume", required: true },
      { tag: "button", label: "Submit application" }
    ];
    const { submitted } = await submitExternal({ database, dataDir, controls, applicationRecord: writerWith(captured) });
    expect(submitted.status).toBe("submitted");
    const endYear = submitted.decisions.find((decision) => decision.fieldId === "end-year--0");
    expect(endYear).toMatchObject({ action: "fill", value: "2028", basis: { kind: "fact", key: "graduation_date" } });
    const html = captured[0]!;
    expect(html).toContain("Graduation date answered on the form: 2028-05-15");
    database.close();
  });

  it("names and appends the uploaded resume the run actually sent", async () => {
    const { dataDir, database } = disposableWorkspace();
    const captured: string[] = [];
    const { submitted, baseResumes } = await submitExternal({
      database, dataDir, controls: FILE_CONTROLS, applicationRecord: writerWith(captured),
      baseResumes: [{ channel: "default", label: "Resume (Expected May 2028)", originalName: "Jordan Rivera Resume.pdf", bytes: minimalPdf(1) }]
    });
    const stored = baseResumes[0]!;
    expect(submitted.baseResumeId).toBe(stored.id);
    const html = captured[0]!;
    expect(html).toContain(escapeHtml(`Uploaded base resume "Resume (Expected May 2028)" (originally Jordan Rivera Resume.pdf)`));
    expect(html).toContain("Uploaded as: Jordan Rivera Resume.pdf");
    expect(html).toContain(stored.sha256);
    expect(html).toContain("Appended after this record.");
    expect(html).not.toContain(`resume-${submitted.variantId}.pdf`);
    expect(countPdfPages(readFileSync(applicationRecordPdfPath(dataDir, submitted.jobId)))).toBe(2);
    database.close();
  });

  it("names the uploaded 2029 resume on a transcript application", async () => {
    const { dataDir, database } = disposableWorkspace();
    const captured: string[] = [];
    const { submitted } = await submitExternal({
      database, dataDir, controls: TRANSCRIPT_CONTROLS, applicationRecord: writerWith(captured),
      baseResumes: [
        { channel: "default", label: "Resume (Expected May 2028)", originalName: "resume-2028.pdf", bytes: minimalPdf(1) },
        { channel: "handshake_internal", label: "Resume (Expected May 2029)", originalName: "resume-2029.pdf", bytes: minimalPdf(1) }
      ]
    });
    const html = captured[0]!;
    expect(html).toContain(escapeHtml(`Uploaded base resume "Resume (Expected May 2029)"`));
    expect(html).toContain("Transcript alternate profile");
    expect(html).not.toContain("graduating");
    expect(countPdfPages(readFileSync(applicationRecordPdfPath(dataDir, submitted.jobId)))).toBe(4);
    database.close();
  });

  it("never fails a submission when the record cannot be written, and logs no path or error", async () => {
    const { dataDir, database } = disposableWorkspace();
    const failing = async () => { throw new Error(`boom ${dataDir}`); };
    const { jobId, submitted } = await submitExternal({
      database, dataDir, controls: TRANSCRIPT_CONTROLS,
      applicationRecord: (input) => saveApplicationRecordQuietly(input, { renderPdf: failing })
    });
    expect(submitted.status).toBe("submitted");
    expect(getJobPosting(database, jobId)?.status).toBe("SUBMITTED");
    expect(details(database, jobId)).toContain(`Application record not saved; run pnpm application:record --job ${jobId}.`);
    for (const detail of details(database, jobId)) {
      expect(detail).not.toContain(dataDir);
      expect(detail).not.toContain("boom");
    }
    expect(existsSync(applicationRecordPdfPath(dataDir, jobId))).toBe(false);
    expect(leftovers(join(dataDir, "applications", jobId))).toEqual([]);
    database.close();
  });

  it("references missing or changed attachments by checksum and finds a transcript moved to documents.removed-*", async () => {
    const { dataDir, database } = disposableWorkspace();
    const { jobId, transcript } = await submitExternal({ database, dataDir, controls: TRANSCRIPT_CONTROLS, applicationRecord: writerWith([]) });
    const recordPath = applicationRecordPdfPath(dataDir, jobId);
    const stored = candidateDocumentFilePath(dataDir, transcript.fileName);
    const regenerate = async () => {
      const captured: string[] = [];
      const [result] = await regenerateApplicationRecords({ database, dataDir, select: { kind: "job", jobId }, renderPdf: fakeRenderer(captured) });
      return { result, html: captured[0] ?? "", pages: countPdfPages(readFileSync(recordPath)) };
    };

    const removed = join(dataDir, "documents.removed-test");
    mkdirSync(removed, { recursive: true });
    renameSync(stored, join(removed, "elsewhere.tmp"));
    const missing = await regenerate();
    expect(missing.result?.status).toBe("saved");
    expect(missing.html).toContain(transcript.sha256);
    expect(missing.html).toContain("Not appended: The file is no longer on disk.");
    expect(missing.pages).toBe(2);

    renameSync(join(removed, "elsewhere.tmp"), join(removed, transcript.fileName));
    const moved = await regenerate();
    expect(moved.result?.status).toBe("saved");
    expect(moved.pages).toBe(4);
    expect(moved.html).not.toContain("Not appended");

    writeFileSync(join(removed, transcript.fileName), minimalPdf(3));
    const changed = await regenerate();
    expect(changed.html).toContain("no longer matches the recorded checksum");
    expect(changed.pages).toBe(2);
    expect(mode(recordPath)).toBe(0o600);
    database.close();
  });

  it("regenerates missing records, all records, and keeps values with reconstructed labels without the sidecar", async () => {
    const { dataDir, database } = disposableWorkspace();
    const { jobId } = await submitExternal({ database, dataDir, controls: TRANSCRIPT_CONTROLS, applicationRecord: writerWith([]) });
    const recordPath = applicationRecordPdfPath(dataDir, jobId);
    const captured: string[] = [];
    const renderPdf = fakeRenderer(captured);

    const skipped = await regenerateApplicationRecords({ database, dataDir, select: { kind: "missing" }, renderPdf });
    expect(skipped).toEqual([expect.objectContaining({ jobId, status: "skipped", detail: "Record already exists." })]);
    expect(recordDetails(database, jobId)).toHaveLength(1);

    rmSync(recordPath);
    const rewritten = await regenerateApplicationRecords({ database, dataDir, select: { kind: "missing" }, renderPdf });
    expect(rewritten[0]?.status).toBe("saved");
    expect(rewritten[0]?.detail.startsWith("applications/")).toBe(true);
    expect(rewritten[0]?.detail).not.toContain(dataDir);
    expect(recordDetails(database, jobId)).toHaveLength(2);

    const all = await regenerateApplicationRecords({ database, dataDir, select: { kind: "all" }, renderPdf });
    expect(all.map((result) => result.status)).toEqual(["saved"]);
    expect(recordDetails(database, jobId)).toEqual([SAVED, SAVED, SAVED]);

    rmSync(submittedFieldLabelsPath(dataDir, jobId));
    await regenerateApplicationRecords({ database, dataDir, select: { kind: "job", jobId }, renderPdf });
    const html = captured.at(-1)!;
    expect(html).toContain("Italic labels were not recorded at submission and are reconstructed from the answer&#39;s source.");
    expect(html).toContain("<em>Graduation date</em>");
    expect(html).toContain("2029-05-15");
    expect(html).not.toContain("What is your expected graduation date?");
    database.close();
  });

  it("writes an honest record for a manual check-off the agent did not fill", async () => {
    const { dataDir, database } = disposableWorkspace();
    const jobId = approvedJobId(database, "qualified");
    prepareApplication(jobId, { database });
    recordManualApplication(jobId, { database });
    const captured: string[] = [];
    const { pages } = await saveApplicationRecord({ database, dataDir, jobId }, { renderPdf: fakeRenderer(captured) });
    expect(captured[0]).toContain("You applied yourself");
    expect(captured[0]).toContain("The agent did not fill this form");
    expect(captured[0]).toContain("Not known: the agent did not fill this application.");
    expect(pages).toBe(1);
    database.close();
  });

  it("refuses to record an application that was not submitted", async () => {
    const { dataDir, database } = disposableWorkspace();
    const jobId = approvedJobId(database);
    await expect(saveApplicationRecord({ database, dataDir, jobId }, { renderPdf: fakeRenderer([]) })).rejects.toThrow("This application has not been submitted.");
    const [result] = await regenerateApplicationRecords({ database, dataDir, select: { kind: "job", jobId }, renderPdf: fakeRenderer([]) });
    expect(result).toMatchObject({ jobId, status: "failed", detail: "This application has not been submitted." });
    expect(existsSync(applicationRecordPdfPath(dataDir, jobId))).toBe(false);
    database.close();
  });

  it("escapes every interpolated string in the record HTML", () => {
    const evil = "<script>alert(1)</script>";
    const record: ApplicationRecord = {
      jobId: randomUUID(), runId: randomUUID(), companyName: evil, title: "Intern \"quoted\" & 'single'",
      postingUrl: "https://example.com/jobs/1?a=1&b=<2>", applicationUrl: null, applicationType: "EXTERNAL_ATS", atsKind: null,
      submittedAt: null, generatedAt: new Date().toISOString(),
      approval: { kind: "policy", at: new Date().toISOString(), basis: evil },
      profile: { kind: "default", graduationDate: evil, answeredGraduation: null },
      fields: [{ label: evil, labelReconstructed: true, value: evil, source: evil }],
      leftBlank: [evil],
      attachments: [{ role: "resume", description: evil, uploadedAs: evil, sha256: null, byteSize: null, pages: null, appended: false, note: evil }],
      confirmation: evil,
      posting: { capturedAt: new Date().toISOString(), text: evil, truncated: true }
    };
    const html = renderApplicationRecordHtml(record);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<a ");
    expect(html).toContain("Intern &quot;quoted&quot; &amp; &#39;single&#39;");
    expect(html).toContain("(Truncated to the first 100,000 characters.)");
  });

  it("reports the profile the run recorded, as the company lock chose it", async () => {
    const { dataDir, database } = disposableWorkspace();
    const captured: string[] = [];
    const { jobId, runId } = await submitExternal({ database, dataDir, controls: FILE_CONTROLS, applicationRecord: writerWith(captured) });

    updateBrowserRun(database, runId, { applicationProfile: "transcript" });
    const captured2: string[] = [];
    const [first] = await regenerateApplicationRecords({ database, dataDir, select: { kind: "job", jobId }, renderPdf: fakeRenderer(captured2) });
    expect(first?.status).toBe("saved");
    const transcriptHtml = captured2[0] ?? "";
    expect(transcriptHtml).toContain("Transcript alternate profile");
    expect(transcriptHtml).toContain("Graduation date for this profile (current saved answer): 2029-05-15");
    expect(transcriptHtml).toMatch(/resume-[0-9a-f-]+-graduating-2029-05-15\.pdf/);
    expect(transcriptHtml).toContain("The printed file is no longer on disk");
    expect(transcriptHtml).not.toContain("Default profile");

    updateBrowserRun(database, runId, { applicationProfile: "default" });
    const captured3: string[] = [];
    await regenerateApplicationRecords({ database, dataDir, select: { kind: "job", jobId }, renderPdf: fakeRenderer(captured3) });
    const defaultHtml = captured3[0] ?? "";
    expect(defaultHtml).toContain("Default profile");
    expect(defaultHtml).toContain("2028-05-15");
    expect(defaultHtml).not.toContain("Transcript alternate profile");
    database.close();
  });
});

describe("pnpm application:record", () => {
  it("reports an empty workspace, checks its arguments, and refuses while a pipeline run holds the lock", () => {
    const dataDir = disposableDataDir();
    const empty = runCli(dataDir, ["--profile", "demo"]);
    expect(empty.status).toBe(0);
    expect(empty.stdout).toContain("No submitted applications.");
    expect(empty.stdout).toContain("APPLICATION_RECORD_REPORT");

    const badJob = runCli(dataDir, ["--profile", "demo", "--job", "not-a-uuid"]);
    expect(badJob.status).toBe(1);
    expect(badJob.stdout).toContain("Usage: pnpm application:record");

    const both = runCli(dataDir, ["--profile", "demo", "--job", randomUUID(), "--all-submitted"]);
    expect(both.status).toBe(1);
    expect(both.stdout).toContain("Usage: pnpm application:record");

    const unknown = runCli(dataDir, ["--profile", "demo", "--everything"]);
    expect(unknown.status).toBe(1);

    const release = acquirePipelineLock(dataDir);
    try {
      const locked = runCli(dataDir, ["--profile", "demo"]);
      expect(locked.status).toBe(1);
      expect(locked.stdout).toContain("Not run:");
    } finally {
      release();
    }
  }, 60_000);
});
