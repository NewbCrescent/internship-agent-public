import type { RepositoryFile } from "@internship-agent/domain";

import type { RemoteTreeEntry } from "./types";

const MAX_FILE_BYTES = 120_000;
const MAX_TOTAL_BYTES = 1_500_000;
const MAX_FILES = 60;
const excludedSegments = new Set([
  "node_modules", "vendor", "dist", "build", "coverage", ".next", ".git",
  "generated", "fixtures", "snapshots", "__snapshots__"
]);
const manifestNames = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "cargo.toml", "go.mod",
  "pom.xml", "build.gradle", "build.gradle.kts", "gemfile", "composer.json"
]);
const sourceExtensions = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".go", ".java", ".js", ".jsx",
  ".kt", ".kts", ".m", ".mm", ".py", ".rs", ".swift", ".ts", ".tsx"
]);

export type SelectedTreeEntry = RemoteTreeEntry & { kind: RepositoryFile["kind"] };

export function selectEvidenceFiles(entries: RemoteTreeEntry[]): SelectedTreeEntry[] {
  const candidates = entries.flatMap((entry): SelectedTreeEntry[] => {
    if (entry.type !== "blob" || entry.size > MAX_FILE_BYTES || isExcluded(entry.path)) return [];
    const kind = classifyPath(entry.path);
    return kind ? [{ ...entry, kind }] : [];
  }).sort((left, right) => {
    const priority = { readme: 0, manifest: 1, source: 2 } as const;
    return priority[left.kind] - priority[right.kind] || left.path.localeCompare(right.path);
  });

  const selected: SelectedTreeEntry[] = [];
  let totalBytes = 0;
  for (const entry of candidates) {
    if (selected.length >= MAX_FILES || totalBytes + entry.size > MAX_TOTAL_BYTES) continue;
    selected.push(entry);
    totalBytes += entry.size;
  }
  return selected;
}

export function classifyPath(path: string): RepositoryFile["kind"] | null {
  const basename = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (/^readme(?:\.[a-z0-9]+)?$/i.test(basename)) return "readme";
  if (manifestNames.has(basename)) return "manifest";
  const dot = basename.lastIndexOf(".");
  return dot >= 0 && sourceExtensions.has(basename.slice(dot)) ? "source" : null;
}

function isExcluded(path: string): boolean {
  return path.split("/").some((segment) => excludedSegments.has(segment.toLowerCase()));
}
