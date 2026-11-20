import type { VoiceRecord } from "./corpus";

// A port of the my-writing-voice skill's analyze_style.py; keep the two in step.
// Diagnostics describe resemblance to the corpus, not human or AI authorship.

const TRANSITIONS = ["however", "therefore", "ultimately", "from this", "even though", "though", "because",
  "for example", "as an example", "this leads", "which"];
const FRAGMENT_STARTERS = ["which", "where", "that", "from this", "along with", "because"];
const GENERIC_PHRASES = ["some of the most interesting", "one of the most important", "throughout history",
  "in today's world", "in the modern world", "not simply", "these differences show", "this demonstrates that",
  "this highlights the importance", "it is important to note", "plays a crucial role", "ultimately",
  "in conclusion", "a deeper understanding", "many questions still remain"];
const FIRST_PERSON = new Set(["i", "i'm", "i’ve", "i've", "me", "my", "mine", "myself", "we", "us", "our", "ours"]);
const STOPWORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from",
  "had", "has", "have", "he", "her", "his", "i", "in", "is", "it", "its", "me",
  "my", "of", "on", "or", "our", "she", "that", "the", "their", "them", "they",
  "this", "to", "us", "was", "we", "were", "which", "who", "will", "with", "you"]);
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "e.g", "i.e"]);

export type StyleMetrics = {
  wordCount: number;
  sentenceCount: number;
  paragraphCount: number;
  sentenceLengthMean: number;
  sentenceLengthSd: number;
  sentenceLengthCv: number;
  sentenceLengthMedian: number;
  sentenceLengthP10: number;
  sentenceLengthP90: number;
  sentenceLengthSpread: number;
  shortSentenceRate: number;
  longSentenceRate: number;
  paragraphWordMean: number;
  paragraphWordSd: number;
  paragraphWordCv: number;
  paragraphSentenceCountMean: number;
  paragraphSentenceCountSd: number;
  sentenceFirstTokenRepeatRate: number;
  sentenceFirstTokenMostCommon: string;
  sentenceFirstBigramRepeatRate: number;
  sentenceFirstBigramMostCommon: string;
  paragraphOpeningRepeatRate: number;
  paragraphOpeningMostCommon: string;
  transitionCount: number;
  transitionRatePer100Sentences: number;
  questionRate: number;
  fragmentStarterRate: number;
  firstPersonRatePer100Words: number;
  mattr50: number;
  genericPhraseHits: Record<string, number>;
};

export type StyleFinding = { severity: "warning" | "strong_warning"; check: string; message: string };
export type StyleAudit = {
  benchmark: "selected_examples" | "category_baseline";
  draft: StyleMetrics;
  overlap: Array<{ phrase: string; referenceIds: string }>;
  findings: StyleFinding[];
};

export function wordTokens(text: string): string[] {
  return [...text.toLowerCase().matchAll(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu)].map((match) => match[0]);
}

const isAlnum = (char: string | undefined) => char !== undefined && /^[\p{L}\p{N}]$/u.test(char);

/** Splits prose while avoiding periods inside common abbreviations and dotted terms. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const chars = [...text];
  let start = 0;
  let inQuote = false;
  const finish = (end: number) => {
    const sentence = chars.slice(start, end).join("").trim();
    if (sentence) sentences.push(sentence);
    start = end;
  };
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if ((char === "“" || char === '"') && !inQuote) { inQuote = true; continue; }
    if ((char === "”" || char === '"') && inQuote) {
      inQuote = false;
      if (index > 0 && ".!?".includes(chars[index - 1]!)) finish(index + 1);
      continue;
    }
    if (inQuote || !".!?".includes(char)) continue;
    if (char === ".") {
      if (index > 0 && isAlnum(chars[index - 1]) && isAlnum(chars[index + 1])) continue;
      const prefix = chars.slice(start, index).join("");
      const lastWord = (/([A-Za-z](?:[A-Za-z.]*)?)$/.exec(prefix)?.[1] ?? "").toLowerCase();
      if (ABBREVIATIONS.has(lastWord) || /^(?:[a-z]\.)+[a-z]?$/.test(lastWord)) continue;
      if (index + 1 < chars.length && /\d/.test(chars[index + 1]!)) continue;
    }
    finish(index + 1);
  }
  finish(chars.length);
  return sentences;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
function populationSd(values: number[]): number {
  if (values.length <= 1) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}
function percentile(values: number[], proportion: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  if (ordered.length === 1) return ordered[0]!;
  const position = (ordered.length - 1) * proportion;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower]!;
  return ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (position - lower);
}
function median(values: number[]): number {
  return values.length ? percentile(values, 0.5) : 0;
}
function movingAverageTtr(tokens: string[], window = 50): number {
  if (tokens.length === 0) return 0;
  if (tokens.length <= window) return new Set(tokens).size / tokens.length;
  const scores: number[] = [];
  for (let index = 0; index <= tokens.length - window; index += 1) {
    scores.push(new Set(tokens.slice(index, index + window)).size / window);
  }
  return mean(scores);
}
function phraseCount(text: string, phrase: string): number {
  const escaped = phrase.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return [...text.toLowerCase().matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "gu"))].length;
}
function maxOpeningRate(openings: string[]): [number, string] {
  if (openings.length === 0) return [0, ""];
  const tally = new Map<string, number>();
  for (const opening of openings) tally.set(opening, (tally.get(opening) ?? 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [opening, count] of tally) if (count > bestCount) { best = opening; bestCount = count; }
  return [bestCount / openings.length, best];
}

export function analyzeTexts(texts: Iterable<string>): StyleMetrics {
  const list = [...texts].map((text) => text.trim()).filter(Boolean);
  const combined = list.join("\n\n");
  const tokens = wordTokens(combined);
  const sentences = list.flatMap((text) => splitSentences(text));
  const paragraphs = list.flatMap((text) => text.split(/\n\s*\n/)).map((paragraph) => paragraph.trim()).filter(Boolean);
  const sentenceLengths = sentences.map((sentence) => wordTokens(sentence).length);
  const paragraphLengths = paragraphs.map((paragraph) => wordTokens(paragraph).length);
  const paragraphSentenceCounts = paragraphs.map((paragraph) => splitSentences(paragraph).length);
  const firstTokens: string[] = [];
  const firstBigrams: string[] = [];
  for (const sentence of sentences) {
    const sentenceTokens = wordTokens(sentence);
    if (sentenceTokens.length) {
      firstTokens.push(sentenceTokens[0]!);
      firstBigrams.push(sentenceTokens.slice(0, 2).join(" "));
    }
  }
  const [firstTokenRate, firstToken] = maxOpeningRate(firstTokens);
  const [firstBigramRate, firstBigram] = maxOpeningRate(firstBigrams);
  const paragraphOpenings = paragraphs.map((paragraph) => wordTokens(paragraph).slice(0, 2).join(" ")).filter(Boolean);
  const [paragraphOpeningRate, paragraphOpening] = maxOpeningRate(paragraphOpenings);
  const transitionCount = TRANSITIONS.reduce((sum, phrase) => sum + phraseCount(combined, phrase), 0);
  const genericPhraseHits: Record<string, number> = {};
  for (const phrase of GENERIC_PHRASES) {
    const count = phraseCount(combined, phrase);
    if (count) genericPhraseHits[phrase] = count;
  }
  const lowerSentences = sentences.map((sentence) => sentence.toLowerCase().replace(/\s+/g, " ").trim());
  const fragmentCount = lowerSentences.filter((sentence) =>
    FRAGMENT_STARTERS.some((starter) => sentence === starter || sentence.startsWith(starter + " "))).length;
  const firstPersonCount = tokens.filter((token) => FIRST_PERSON.has(token)).length;
  const questionCount = sentences.filter((sentence) => sentence.trimEnd().endsWith("?")).length;
  const sentenceMean = mean(sentenceLengths);
  const sentenceSd = populationSd(sentenceLengths);
  const p10 = percentile(sentenceLengths, 0.1);
  const p90 = percentile(sentenceLengths, 0.9);
  const rate = (count: number, total: number) => total ? round3(count / total) : 0;
  const paragraphMean = mean(paragraphLengths);
  return {
    wordCount: tokens.length,
    sentenceCount: sentences.length,
    paragraphCount: paragraphs.length,
    sentenceLengthMean: round3(sentenceMean),
    sentenceLengthSd: round3(sentenceSd),
    sentenceLengthCv: round3(sentenceMean ? sentenceSd / sentenceMean : 0),
    sentenceLengthMedian: round3(median(sentenceLengths)),
    sentenceLengthP10: round3(p10),
    sentenceLengthP90: round3(p90),
    sentenceLengthSpread: round3(p90 - p10),
    shortSentenceRate: rate(sentenceLengths.filter((length) => length <= 8).length, sentenceLengths.length),
    longSentenceRate: rate(sentenceLengths.filter((length) => length >= 30).length, sentenceLengths.length),
    paragraphWordMean: round3(paragraphMean),
    paragraphWordSd: round3(populationSd(paragraphLengths)),
    paragraphWordCv: round3(paragraphMean ? populationSd(paragraphLengths) / paragraphMean : 0),
    paragraphSentenceCountMean: round3(mean(paragraphSentenceCounts)),
    paragraphSentenceCountSd: round3(populationSd(paragraphSentenceCounts)),
    sentenceFirstTokenRepeatRate: round3(firstTokenRate),
    sentenceFirstTokenMostCommon: firstToken,
    sentenceFirstBigramRepeatRate: round3(firstBigramRate),
    sentenceFirstBigramMostCommon: firstBigram,
    paragraphOpeningRepeatRate: round3(paragraphOpeningRate),
    paragraphOpeningMostCommon: paragraphOpening,
    transitionCount,
    transitionRatePer100Sentences: sentences.length ? round3(transitionCount * 100 / sentences.length) : 0,
    questionRate: rate(questionCount, sentences.length),
    fragmentStarterRate: rate(fragmentCount, sentences.length),
    firstPersonRatePer100Words: tokens.length ? round3(firstPersonCount * 100 / tokens.length) : 0,
    mattr50: round3(movingAverageTtr(tokens)),
    genericPhraseHits
  };
}

function contentNgrams(tokens: string[], size = 8): Set<string> {
  const results = new Set<string>();
  for (let index = 0; index <= tokens.length - size; index += 1) {
    const ngram = tokens.slice(index, index + size);
    if (ngram.filter((token) => !STOPWORDS.has(token)).length >= 4) results.add(ngram.join(" "));
  }
  return results;
}

/** Nontrivial exact eight-word overlaps with the corpus: copied wording, not style. */
export function findReferenceOverlap(draft: string, records: VoiceRecord[], size = 8): Array<{ phrase: string; referenceIds: string }> {
  const draftNgrams = contentNgrams(wordTokens(draft), size);
  if (draftNgrams.size === 0) return [];
  const owners = new Map<string, string[]>();
  for (const record of records) {
    for (const ngram of contentNgrams(wordTokens(record.text), size)) {
      if (draftNgrams.has(ngram)) owners.set(ngram, [...(owners.get(ngram) ?? []), record.id]);
    }
  }
  return [...owners.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 10)
    .map(([phrase, ids]) => ({ phrase, referenceIds: [...ids].sort().join(", ") }));
}

function ratioWarning(findings: StyleFinding[], check: string, draft: number, benchmark: number, low = 0.7, high = 1.4): void {
  if (benchmark <= 0) return;
  const ratio = draft / benchmark;
  if (ratio < low || ratio > high) {
    findings.push({ severity: "warning", check, message: `${draft.toFixed(2)} versus ${benchmark.toFixed(2)} in the benchmark (${ratio.toFixed(2)}x).` });
  }
}

export function buildFindings(draft: StyleMetrics, benchmark: StyleMetrics, overlap: StyleAudit["overlap"]): StyleFinding[] {
  const findings: StyleFinding[] = [];
  const tolerance = Math.max(3, benchmark.sentenceLengthMean * 0.2);
  if (Math.abs(draft.sentenceLengthMean - benchmark.sentenceLengthMean) > tolerance) {
    findings.push({ severity: "warning", check: "sentence_length_mean",
      message: `${draft.sentenceLengthMean.toFixed(2)} words versus ${benchmark.sentenceLengthMean.toFixed(2)}; tolerance is ±${tolerance.toFixed(2)}.` });
  }
  // Distribution estimates are unstable on very short drafts.
  if (draft.sentenceCount >= 10) {
    ratioWarning(findings, "sentence_length_sd", draft.sentenceLengthSd, benchmark.sentenceLengthSd);
    ratioWarning(findings, "sentence_length_cv", draft.sentenceLengthCv, benchmark.sentenceLengthCv);
    ratioWarning(findings, "sentence_length_spread", draft.sentenceLengthSpread, benchmark.sentenceLengthSpread);
  }
  if (draft.paragraphCount >= 4 && draft.paragraphWordCv < 0.15 &&
    (benchmark.paragraphWordCv <= 0 || draft.paragraphWordCv < benchmark.paragraphWordCv * 0.5)) {
    findings.push({ severity: "strong_warning", check: "paragraph_uniformity",
      message: `Paragraph-length CV is ${draft.paragraphWordCv.toFixed(2)} across ${draft.paragraphCount} paragraphs; the structure is unusually uniform.` });
  }
  if (draft.sentenceCount >= 10 && draft.sentenceFirstTokenRepeatRate > 0.25) {
    findings.push({ severity: "warning", check: "sentence_opening_repetition",
      message: `${Math.round(draft.sentenceFirstTokenRepeatRate * 100)}% of sentences share the most common first word: ${draft.sentenceFirstTokenMostCommon}.` });
  }
  if (draft.paragraphCount >= 4 && draft.paragraphOpeningRepeatRate > 0.4) {
    findings.push({ severity: "warning", check: "paragraph_opening_repetition",
      message: `${Math.round(draft.paragraphOpeningRepeatRate * 100)}% of paragraphs share the most common opening: ${draft.paragraphOpeningMostCommon}.` });
  }
  if (draft.sentenceCount >= 10) {
    ratioWarning(findings, "transition_density", draft.transitionRatePer100Sentences, benchmark.transitionRatePer100Sentences, 0.5, 2);
  }
  const genericTotal = Object.values(draft.genericPhraseHits).reduce((sum, count) => sum + count, 0);
  if (genericTotal >= 2) {
    findings.push({ severity: "warning", check: "generic_templates",
      message: `Found ${genericTotal} stock-phrase occurrences: ${Object.keys(draft.genericPhraseHits).join(", ")}.` });
  }
  if (overlap.length) {
    findings.push({ severity: "strong_warning", check: "reference_overlap",
      message: `Found ${overlap.length} nontrivial exact eight-word overlap(s) with the reference corpus.` });
  }
  return findings;
}

/** Audits a draft against the selected examples (or, without any, the whole category). */
export function auditDraft(draft: string, records: VoiceRecord[], selected: VoiceRecord[], categoryRecords: VoiceRecord[]): StyleAudit {
  const benchmark = analyzeTexts((selected.length ? selected : categoryRecords).map((record) => record.text));
  const metrics = analyzeTexts([draft]);
  const overlap = findReferenceOverlap(draft, records);
  return {
    benchmark: selected.length ? "selected_examples" : "category_baseline",
    draft: metrics,
    overlap,
    findings: buildFindings(metrics, benchmark, overlap)
  };
}
