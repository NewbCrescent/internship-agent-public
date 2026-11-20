import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const VOICE_CATEGORIES = [
  "academic_analysis",
  "applications_and_professional",
  "personal_reflection_and_identity",
  "persuasive_and_opinion",
  "technical_and_project_writing"
] as const;
export type VoiceCategory = (typeof VOICE_CATEGORIES)[number];

export const voiceRecordSchema = z.object({
  id: z.string().min(1),
  category: z.enum(VOICE_CATEGORIES),
  title: z.string(),
  source_file: z.string(),
  word_count: z.number().int().nonnegative(),
  text: z.string().min(1)
});
export type VoiceRecord = z.infer<typeof voiceRecordSchema>;

/**
 * The candidate's private writing-voice material. It lives only in the
 * Git-ignored local data directory; the evaluation holdout is never loaded.
 */
export type VoiceCorpus = {
  records: VoiceRecord[];
  voiceProfile: string;
  categoryGuide: string;
  auditRubric: string;
  authorshipGate: string;
};

const REQUIRED_FILES = {
  records: "reference-dataset.jsonl",
  voiceProfile: "voice-profile.md",
  categoryGuide: "category-guide.md",
  auditRubric: "audit-rubric.md",
  authorshipGate: "authorship-gate.md"
} as const;

/** Returns null when the directory or any required file is missing. */
export function loadVoiceCorpus(directory: string): VoiceCorpus | null {
  const paths = Object.fromEntries(
    Object.entries(REQUIRED_FILES).map(([key, name]) => [key, join(directory, name)])
  ) as Record<keyof typeof REQUIRED_FILES, string>;
  if (!Object.values(paths).every((path) => existsSync(path))) return null;
  const records = readFileSync(paths.records, "utf8").split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => voiceRecordSchema.parse(JSON.parse(line) as unknown));
  if (records.length === 0) return null;
  return {
    records,
    voiceProfile: readFileSync(paths.voiceProfile, "utf8"),
    categoryGuide: readFileSync(paths.categoryGuide, "utf8"),
    auditRubric: readFileSync(paths.auditRubric, "utf8"),
    authorshipGate: readFileSync(paths.authorshipGate, "utf8")
  };
}

/** The category-guide section for one category ("## <category>" heading). */
export function categoryGuideSection(guide: string, category: VoiceCategory): string {
  const lines = guide.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,3}\s/.test(line) && line.includes(category));
  if (start < 0) return "";
  const level = /^(#+)/.exec(lines[start]!)![1]!.length;
  const end = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${level}}\\s`).test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trim();
}
