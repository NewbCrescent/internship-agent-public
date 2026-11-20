import { VOICE_CATEGORIES, type VoiceCategory, type VoiceRecord } from "./corpus";

// A port of the my-writing-voice skill's select_examples.py; keep the two in step.

const CATEGORY_HINTS: Record<VoiceCategory, Set<string>> = {
  academic_analysis: new Set(["academic", "analysis", "analyze", "argument", "class", "course", "essay",
    "exam", "history", "literature", "paper", "poem", "research", "thesis"]),
  applications_and_professional: new Set(["application", "apply", "club", "college", "cover", "fellowship", "internship",
    "job", "opportunity", "personal", "scholarship", "statement", "urap"]),
  personal_reflection_and_identity: new Set(["belief", "experience", "faith", "family", "identity", "lesson", "personal",
    "reflect", "reflection", "story"]),
  persuasive_and_opinion: new Set(["advocacy", "argue", "editorial", "op-ed", "opinion", "persuade", "policy",
    "position", "speech"]),
  technical_and_project_writing: new Set(["code", "data", "development", "engineering", "implementation", "interface",
    "project", "software", "technical", "technology", "ui", "ux", "website"])
};

const STOPWORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i",
  "in", "into", "is", "it", "me", "my", "of", "on", "or", "that", "the", "this",
  "to", "use", "want", "with", "write", "writing"]);

function tokenize(text: string): string[] {
  return [...text.toLowerCase().matchAll(/[a-z0-9]+(?:[-'][a-z0-9]+)?/g)]
    .map((match) => match[0])
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function counts(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
  return map;
}

export function inferVoiceCategory(query: string): VoiceCategory {
  const tokens = new Set(tokenize(query));
  let best: VoiceCategory = VOICE_CATEGORIES[0];
  let bestScore = -1;
  for (const category of VOICE_CATEGORIES) {
    const score = [...tokens].filter((token) => CATEGORY_HINTS[category].has(token)).length;
    if (score > bestScore) { best = category; bestScore = score; }
  }
  return bestScore > 0 ? best : "academic_analysis";
}

function scoreRecord(record: VoiceRecord, query: Map<string, number>): number {
  const title = counts(tokenize(record.title));
  const text = counts(tokenize(record.text));
  const source = counts(tokenize(record.source_file));
  let score = 0;
  for (const [token, frequency] of query) {
    score += Math.min(title.get(token) ?? 0, 2) * 7 * frequency;
    score += Math.min(source.get(token) ?? 0, 2) * 2 * frequency;
    score += Math.log1p(text.get(token) ?? 0) * 1.5 * frequency;
  }
  if (record.word_count >= 100 && record.word_count <= 750) score += 2;
  else if (record.word_count < 60) score -= 2;
  else if (record.word_count > 1300) score -= 1;
  return score;
}

/**
 * Picks prompt-time style examples: relevant records from the category,
 * preferring distinct source files, within a combined word budget.
 */
export function selectVoiceExamples(
  records: VoiceRecord[],
  category: VoiceCategory,
  query: string,
  options: { count?: number; maxWords?: number } = {}
): VoiceRecord[] {
  const count = Math.min(8, Math.max(1, options.count ?? 4));
  const maxWords = Math.max(100, options.maxWords ?? 2400);
  const queryCounts = counts(tokenize(query));
  const ranked = records.filter((record) => record.category === category)
    .map((record) => ({ record, score: scoreRecord(record, queryCounts) }))
    .sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0))
    .map(({ record }) => record);
  const selected: VoiceRecord[] = [];
  const usedSources = new Set<string>();
  let totalWords = 0;
  for (const allowRepeatedSource of [false, true]) {
    for (const record of ranked) {
      if (selected.includes(record)) continue;
      if (!allowRepeatedSource && usedSources.has(record.source_file)) continue;
      if (selected.length > 0 && totalWords + record.word_count > maxWords) continue;
      selected.push(record);
      usedSources.add(record.source_file);
      totalWords += record.word_count;
      if (selected.length >= count) return selected;
    }
  }
  return selected;
}
