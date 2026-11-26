import { join, resolve } from "node:path";

/**
 * Resume files live under the local data directory (git-ignored), never in
 * fixtures or reports. The worker renders the frozen variant markdown to PDF
 * on demand, or uses a candidate-supplied base resume, and hands the path to
 * the upload decision.
 */
export function resumePdfPath(dataDir: string, jobId: string, variantId: string): string {
  return resolve(join(dataDir, "applications", jobId, `resume-${variantId}.pdf`));
}

/** The local record of what one application sent; it never leaves this computer. */
export function applicationRecordPdfPath(dataDir: string, jobId: string): string {
  return resolve(join(dataDir, "applications", jobId, "application-record.pdf"));
}

/** Form labels captured when the application was submitted, so a regenerated record keeps them. */
export function submittedFieldLabelsPath(dataDir: string, jobId: string): string {
  return resolve(join(dataDir, "applications", jobId, "submitted-field-labels.json"));
}

/** Where a run's post-submit evidence folders live (mode 700, files 600); never sent anywhere. */
export function submitEvidenceRoot(dataDir: string, jobId: string): string {
  return resolve(join(dataDir, "applications", jobId, "submit-evidence"));
}

/** Where a job's stop captures live (Track 42; mode 700, files 600); never sent anywhere. */
export function stopEvidenceRoot(dataDir: string, jobId: string): string {
  return resolve(join(dataDir, "applications", jobId, "stop-evidence"));
}

/** Where a job's kept Playwright run traces live (Track 42; mode 700, files 600); never sent anywhere. */
export function runTracesRoot(dataDir: string, jobId: string): string {
  return resolve(join(dataDir, "applications", jobId, "run-traces"));
}

/** Playwright's intermediate trace files for the profile's browser (launchPersistentContext tracesDir; mode 700). */
export function traceArtifactsDir(dataDir: string): string {
  return resolve(join(dataDir, "trace-artifacts"));
}

export function baseResumeFilePath(dataDir: string, fileName: string): string {
  return resolve(join(dataDir, "resumes", fileName));
}

/** The candidate's own file name for an uploaded resume, safe as a single path segment. */
export function uploadFileName(originalName: string): string {
  const base = originalName.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9 ._()-]/g, "_").replace(/^[.\s]+/, "").trim().slice(0, 120);
  const named = cleaned || "resume";
  return /\.pdf$/i.test(named) ? named : `${named}.pdf`;
}

/** Where an uploaded resume is copied, under its own file name, right before a run uploads it. */
export function baseResumeUploadPath(dataDir: string, jobId: string, baseResumeId: string, originalName: string): string {
  return resolve(join(dataDir, "applications", jobId, "uploads", baseResumeId, uploadFileName(originalName)));
}

export function candidateDocumentFilePath(dataDir: string, fileName: string): string {
  return resolve(join(dataDir, "documents", fileName));
}

export function resolveDataDir(explicit?: string): string {
  if (explicit?.trim()) return resolve(explicit);
  const override = process.env.INTERNSHIP_AGENT_DATA_DIR?.trim();
  if (override) return resolve(override);
  return resolve(process.cwd(), "data");
}
