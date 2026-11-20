import { createHash } from "node:crypto";

/**
 * Establishes the coordinate system every span points into. Pasted postings
 * arrive with inconsistent bullets, non-breaking spaces, and soft wrapping;
 * normalization must be idempotent so a re-paste of the same posting produces
 * the same hash and is recognized as unchanged.
 */
export function normalizePostingText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    // Includes a literal "-": ATS plain-text exports commonly indent bullets
    // as " - item", which would otherwise not be recognized as a bullet at all.
    .replace(/^[ \t]*[-\u2022\u25cf\u25aa\u00b7*+\u2043]\s+/gmu, "- ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function contentHash(normalizedText: string): string {
  return createHash("sha256").update(normalizedText).digest("hex");
}

export type PostingLine = {
  text: string;
  start: number;
  end: number;
};

/** Line-indexed view of the normalized text, carrying absolute offsets. */
export function toLines(normalizedText: string): PostingLine[] {
  const lines: PostingLine[] = [];
  let offset = 0;
  for (const text of normalizedText.split("\n")) {
    lines.push({ text, start: offset, end: offset + text.length });
    offset += text.length + 1;
  }
  return lines;
}

export function isBullet(line: string): boolean {
  return /^- /.test(line);
}

export function bulletBody(line: string): string {
  return line.replace(/^- /, "").trim();
}

/**
 * A heading is a short, non-bullet line that either ends in a colon or reads
 * like a section title. Postings vary wildly, so this stays deliberately
 * conservative: a missed heading degrades classification, a false one would
 * mislabel whole blocks of requirements.
 */
export function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 80 || isBullet(trimmed)) return false;
  if (trimmed.endsWith(":")) return true;
  return /^[A-Z][^.!?]*$/.test(trimmed) && trimmed.split(" ").length <= 8;
}
