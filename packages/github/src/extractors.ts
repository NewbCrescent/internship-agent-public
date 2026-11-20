import type { ExtractedClaimInput, ExtractedEvidenceInput } from "@internship-agent/db";
import type { ClaimKind, EvidenceKind, RepositoryFile } from "@internship-agent/domain";

import { sha256, sourceUrl } from "./provenance";
import type { RemoteFileContent, RemoteRepositorySnapshot } from "./types";

export type AnalyzedFile = RemoteFileContent & {
  kind: RepositoryFile["kind"];
  contentHash: string;
};

type ClaimDraft = Omit<ExtractedClaimInput, "evidenceFingerprint">;

const sourceSignals = [
  { key: "openmp", label: "OpenMP", pattern: /(?:#\s*pragma\s+omp|\bopenmp\b)/i },
  { key: "arm-neon", label: "ARM NEON", pattern: /(?:arm_neon|\bneon\b)/i },
  { key: "simd", label: "SIMD", pattern: /\bsimd\b/i },
  { key: "cuda", label: "CUDA", pattern: /(?:\bcuda\b|\.cu\b)/i },
  { key: "sqlite", label: "SQLite", pattern: /(?:node:sqlite|\bsqlite3?\b|\bDatabaseSync\b)/i },
  { key: "nextjs", label: "Next.js", pattern: /(?:from\s+["']next(?:\/|["'])|next\.config)/i },
  { key: "react", label: "React", pattern: /(?:from\s+["']react["']|\bReact\.)/ },
  { key: "supabase", label: "Supabase", pattern: /(?:@supabase|\bsupabase\b)/i },
  { key: "playwright", label: "Playwright", pattern: /(?:@playwright\/test|\bplaywright\b)/i },
  { key: "turborepo", label: "Turborepo", pattern: /(?:turbo\.json|\bturborepo\b)/i },
  { key: "mlx", label: "MLX", pattern: /\bmlx\b/i }
] as const;

export function extractRepositoryClaims(
  snapshot: RemoteRepositorySnapshot,
  files: AnalyzedFile[]
): { summary: string | null; claims: ExtractedClaimInput[] } {
  const drafts = new Map<string, ClaimDraft>();
  const readmeSummary = firstReadmeSummary(files);
  const summary = snapshot.description?.trim() || readmeSummary?.text || null;

  if (summary) {
    const evidence = snapshot.description?.trim()
      ? metadataEvidence(snapshot, `Repository description: ${summary}`)
      : fileEvidence(snapshot, readmeSummary!.file, readmeSummary!.line, readmeSummary!.line, readmeSummary!.text);
    addDraft(drafts, "project", "summary", summary, evidence);
  }

  for (const language of Object.keys(snapshot.languages).sort()) {
    addDraft(
      drafts,
      "technology",
      `language:${normalizeKey(language)}`,
      `Repository contains ${language} source code.`,
      metadataEvidence(snapshot, `GitHub language analysis: ${language}`)
    );
  }

  for (const topic of snapshot.topics.slice().sort()) {
    addDraft(
      drafts,
      "technology",
      `topic:${normalizeKey(topic)}`,
      `Repository is tagged with ${topic}.`,
      metadataEvidence(snapshot, `GitHub repository topic: ${topic}`)
    );
  }

  for (const file of files) {
    extractMetrics(snapshot, file, drafts);
    extractPackageDependencies(snapshot, file, drafts);
    extractSourceSignals(snapshot, file, drafts);
  }

  const claims = [...drafts.values()].map((draft) => ({
    ...draft,
    evidenceFingerprint: sha256(draft.evidence
      .map((item) => `${item.path}:${item.excerptHash}`)
      .sort()
      .join("|"))
  }));
  return { summary, claims };
}

function addDraft(
  drafts: Map<string, ClaimDraft>,
  kind: ClaimKind,
  normalizedKey: string,
  text: string,
  evidence: ExtractedEvidenceInput
): void {
  const key = `${kind}:${normalizedKey}`;
  const existing = drafts.get(key);
  if (existing) {
    if (!existing.evidence.some((item) => item.path === evidence.path && item.excerptHash === evidence.excerptHash)) {
      existing.evidence.push(evidence);
    }
    return;
  }
  drafts.set(key, { kind, normalizedKey, text, evidence: [evidence] });
}

function firstReadmeSummary(files: AnalyzedFile[]) {
  for (const file of files.filter((item) => item.kind === "readme")) {
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line || line.startsWith("#") || line.startsWith("[") || line.startsWith("![") || line.startsWith("<")) continue;
      if (line.length >= 30) return { file, line: index + 1, text: line.slice(0, 1_000) };
    }
  }
  return null;
}

function extractMetrics(
  snapshot: RemoteRepositorySnapshot,
  file: AnalyzedFile,
  drafts: Map<string, ClaimDraft>
): void {
  if (file.kind !== "readme") return;
  const lines = file.content.split(/\r?\n/);
  let count = 0;
  for (let index = 0; index < lines.length && count < 8; index += 1) {
    const line = lines[index].trim().replace(/^[-*]\s+/, "");
    if (line.length < 12 || line.length > 500) continue;
    const hasMeasurement = /(\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?x\b|\b\d+(?:\.\d+)?\s?(?:ms|seconds?|minutes?|hours?)\b)/i.test(line);
    const hasPerformanceContext = /(?:faster|speedup|latency|throughput|performance|reduced|improved|benchmark)/i.test(line);
    if (!hasMeasurement || !hasPerformanceContext) continue;
    const stableContext = normalizeKey(line.replace(/\d+(?:\.\d+)?/g, "number")).slice(0, 140);
    addDraft(
      drafts,
      "metric",
      `readme:${stableContext}`,
      line,
      fileEvidence(snapshot, file, index + 1, index + 1, line)
    );
    count += 1;
  }
}

function extractPackageDependencies(
  snapshot: RemoteRepositorySnapshot,
  file: AnalyzedFile,
  drafts: Map<string, ClaimDraft>
): void {
  if (file.kind !== "manifest" || file.path.split("/").at(-1)?.toLowerCase() !== "package.json") return;
  let manifest: unknown;
  try {
    manifest = JSON.parse(file.content);
  } catch {
    return;
  }
  if (!manifest || typeof manifest !== "object") return;
  const record = manifest as Record<string, unknown>;
  const dependencies = { ...stringRecord(record.dependencies), ...stringRecord(record.devDependencies) };
  const lines = file.content.split(/\r?\n/);
  for (const dependency of Object.keys(dependencies).sort().slice(0, 30)) {
    const lineIndex = lines.findIndex((line) => line.includes(`"${dependency}"`));
    const line = lineIndex >= 0 ? lines[lineIndex].trim() : `Dependency: ${dependency}`;
    addDraft(
      drafts,
      "technology",
      `dependency:${normalizeKey(dependency)}`,
      `Project declares ${dependency} as a dependency.`,
      fileEvidence(snapshot, file, Math.max(1, lineIndex + 1), Math.max(1, lineIndex + 1), line)
    );
  }
}

function extractSourceSignals(
  snapshot: RemoteRepositorySnapshot,
  file: AnalyzedFile,
  drafts: Map<string, ClaimDraft>
): void {
  // Only code is implementation evidence. A README mention or a manifest
  // script names a tool without showing it used; manifest dependencies
  // already produce their own dependency claims.
  if (file.kind !== "source") return;
  const lines = file.content.split(/\r?\n/);
  for (const signal of sourceSignals) {
    const lineIndex = lines.findIndex((line) => signal.pattern.test(line));
    if (lineIndex < 0) continue;
    const line = lines[lineIndex].trim().slice(0, 500);
    addDraft(
      drafts,
      "skill",
      `source:${signal.key}`,
      `Source contains implementation evidence for ${signal.label}.`,
      fileEvidence(snapshot, file, lineIndex + 1, lineIndex + 1, line)
    );
  }
}

function metadataEvidence(snapshot: RemoteRepositorySnapshot, excerpt: string): ExtractedEvidenceInput {
  const path = ".github/repository-metadata.json";
  return {
    kind: "repository_metadata",
    commitSha: snapshot.headSha,
    path,
    startLine: 1,
    endLine: 1,
    sourceUrl: `${snapshot.url}/tree/${snapshot.headSha}`,
    excerpt,
    excerptHash: sha256(excerpt)
  };
}

function fileEvidence(
  snapshot: RemoteRepositorySnapshot,
  file: AnalyzedFile,
  startLine: number,
  endLine: number,
  excerpt: string
): ExtractedEvidenceInput {
  const kind: EvidenceKind = file.kind;
  return {
    kind,
    commitSha: snapshot.headSha,
    path: file.path,
    startLine,
    endLine,
    sourceUrl: sourceUrl(snapshot.url, snapshot.headSha, file.path, startLine, endLine),
    excerpt,
    excerptHash: sha256(`${file.blobSha}:${excerpt}`)
  };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || sha256(value).slice(0, 12);
}
