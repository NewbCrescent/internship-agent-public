import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { getCandidate, listProjectEvidenceProfiles, listResumeEntries, recordModelInvocation } from "@internship-agent/db";
import {
  isDraftableQuestion,
  type FillDecision,
  type JobPosting,
  type PauseRecord,
  type RecognizedForm,
  type VoiceDraft,
  type VoiceGateSummary
} from "@internship-agent/domain";
import {
  auditDraft,
  categoryGuideSection,
  createCommandVoiceGate,
  loadVoiceCorpus,
  selectVoiceExamples,
  type StyleFinding,
  type VoiceCorpus,
  type VoiceGate,
  type VoiceGateResult
} from "@internship-agent/voice";

import { OpenAiCompatibleProvider } from "./model/openai-compatible-provider";
import type { ModelProvider, ModelTask } from "./model/provider";

/** Detector-informed revisions after the first draft; the candidate set this limit. */
export const MAX_VOICE_REVISIONS = 5;
const CATEGORY = "applications_and_professional";
const MAX_DRAFT_CHARS = 4_000;

/** One piece of the candidate's own material a draft may rely on. */
export type DraftSource = { id: string; text: string };

export type DraftRequest = {
  question: string;
  companyName: string;
  title: string;
  postingText: string;
  sources: DraftSource[];
  jobId: string | null;
};

export type DraftOutcome =
  | { status: "filled"; text: string; gate: VoiceGateSummary }
  | { status: "blank"; draft: VoiceDraft };

export type VoiceDrafter = (request: DraftRequest) => Promise<DraftOutcome>;

const draftSchema = z.object({
  /** True when the supplied material cannot honestly answer the question. */
  insufficientMaterial: z.boolean(),
  text: z.string(),
  claims: z.array(z.object({ sentence: z.string(), sources: z.array(z.string()) })).max(40)
});
type ModelDraft = z.infer<typeof draftSchema>;

/**
 * Drafting needs all three: a model, the candidate's local voice corpus, and
 * the voice gate. The gate is mandatory, so without it nothing is drafted.
 */
export function createDefaultVoiceDrafter(options: {
  dataDir: string;
  database?: DatabaseSync;
  env?: Record<string, string | undefined>;
}): VoiceDrafter | null {
  const env = options.env ?? process.env;
  const provider = new OpenAiCompatibleProvider();
  const gateCommand = env.VOICE_GATE_COMMAND?.trim();
  const corpusDir = env.INTERNSHIP_AGENT_VOICE_DIR?.trim() || join(options.dataDir, "voice");
  if (!provider.available || !gateCommand || !existsSync(gateCommand)) return null;
  const corpus = loadVoiceCorpus(corpusDir);
  if (!corpus) return null;
  return createVoiceDrafter({ provider, corpus, gate: createCommandVoiceGate(gateCommand), database: options.database });
}

type Attempt = { text: string; problems: string[]; findings: StyleFinding[]; gate: VoiceGateResult | null; gateError: string | null };

export function createVoiceDrafter(deps: {
  provider: ModelProvider;
  corpus: VoiceCorpus;
  gate: VoiceGate;
  database?: DatabaseSync;
  maxRevisions?: number;
}): VoiceDrafter {
  const maxRevisions = deps.maxRevisions ?? MAX_VOICE_REVISIONS;
  return async (request) => {
    const categoryRecords = deps.corpus.records.filter((record) => record.category === CATEGORY);
    const examples = selectVoiceExamples(deps.corpus.records, CATEGORY, `${request.question} ${request.title} internship application`, { count: 4, maxWords: 2400 });
    const sourceIds = new Set(["posting", ...request.sources.map((source) => source.id)]);
    const input = JSON.stringify({
      question: request.question,
      company: request.companyName,
      role: request.title,
      posting: request.postingText.slice(0, 4_000),
      candidateMaterial: request.sources,
      styleExamples: examples.map((example) => ({ id: example.id, title: example.title, text: example.text }))
    });
    const instructions = draftingInstructions(deps.corpus);

    let best: Attempt | null = null;
    let previous: Attempt | null = null;
    for (let revision = 0; revision <= maxRevisions; revision += 1) {
      const task: ModelTask = revision === 0 ? "application.answer_draft" : "application.voice_revision";
      let draft: ModelDraft;
      try {
        draft = await complete(deps, task, request.jobId, instructions,
          previous ? revisionInput(input, previous, deps.corpus) : input);
      } catch (error) {
        return blank(best, revision, `The model could not draft this answer: ${messageOf(error)}`);
      }
      if (draft.insufficientMaterial) {
        return blank(best, revision, "Your recorded material does not answer this question, so nothing was drafted. Please write it.");
      }
      const text = draft.text.trim();
      const problems = groundingProblems(text, draft, sourceIds, request);
      const audit = auditDraft(text, deps.corpus.records, examples, categoryRecords);
      const attempt: Attempt = { text, problems, findings: audit.findings, gate: null, gateError: null };
      // Copied corpus wording and ungrounded claims are fixed before any gate run.
      if (problems.length === 0 && !audit.findings.some((finding) => finding.check === "reference_overlap")) {
        try {
          attempt.gate = await deps.gate(text);
        } catch (error) {
          attempt.gateError = messageOf(error);
        }
      }
      if (problems.length === 0 && attempt.gate) best = better(best, attempt);
      if (attempt.gateError) {
        return blank(best ?? { ...attempt }, revision, `The voice gate could not run (${attempt.gateError}); drafts never fill a field without it.`);
      }
      if (problems.length === 0 && attempt.gate?.passed && !audit.findings.some((finding) => finding.check === "reference_overlap")) {
        return { status: "filled", text, gate: summary(attempt.gate, revision) };
      }
      previous = attempt;
    }
    return blank(best, maxRevisions, best
      ? `The draft did not clear the voice gate after ${maxRevisions} revisions. The best version is shown; please write the answer yourself.`
      : `No draft stayed grounded in your material after ${maxRevisions} revisions. Please write the answer yourself.`);
  };
}

async function complete(
  deps: { provider: ModelProvider; database?: DatabaseSync },
  task: ModelTask,
  jobId: string | null,
  instructions: string,
  input: string
): Promise<ModelDraft> {
  try {
    const result = await deps.provider.complete({ task, tier: "cheap", jobId, instructions, input, schema: draftSchema, maxOutputTokens: 12_000 });
    if (deps.database) {
      recordModelInvocation(deps.database, {
        task, tier: "cheap", model: result.model, jobId, inputTokens: result.inputTokens,
        outputTokens: result.outputTokens, durationMs: result.durationMs, outcome: "succeeded"
      });
    }
    return result.value;
  } catch (error) {
    if (deps.database) {
      recordModelInvocation(deps.database, {
        task, tier: "cheap", model: "unavailable", jobId, inputTokens: 0, outputTokens: 0, durationMs: 0, outcome: "failed"
      });
    }
    throw error;
  }
}

/**
 * The authorship gate, applied mechanically: every claim cites supplied
 * material, and every number in the draft appears in that material, the
 * question, or the posting.
 */
function groundingProblems(text: string, draft: ModelDraft, sourceIds: Set<string>, request: DraftRequest): string[] {
  const problems: string[] = [];
  if (!text) return ["The draft is empty."];
  if (text.length > MAX_DRAFT_CHARS) problems.push(`The draft is ${text.length} characters; keep it under ${MAX_DRAFT_CHARS}.`);
  if (draft.claims.length === 0) problems.push("List each factual claim with the ids of the material that supports it.");
  for (const claim of draft.claims) {
    const unknown = claim.sources.filter((id) => !sourceIds.has(id));
    if (claim.sources.length === 0) problems.push(`Unsupported claim: "${claim.sentence.slice(0, 160)}". Remove it or cite supplied material.`);
    else if (unknown.length) problems.push(`Claim cites unknown material ${unknown.join(", ")}: "${claim.sentence.slice(0, 160)}".`);
  }
  const allowedText = [request.question, request.postingText, request.companyName, request.title, ...request.sources.map((source) => source.text)].join(" ");
  for (const number of new Set(text.match(/\d[\d,.]*%?/g) ?? [])) {
    const bare = number.replace(/[.,]+$/, "");
    if (!allowedText.includes(bare)) problems.push(`The number "${bare}" does not appear in your material; remove it.`);
  }
  return problems;
}

function better(current: Attempt | null, candidate: Attempt): Attempt {
  if (!current?.gate) return candidate;
  if (!candidate.gate) return current;
  if (candidate.gate.passed !== current.gate.passed) return candidate.gate.passed ? candidate : current;
  if (candidate.gate.averagePercentile !== current.gate.averagePercentile) {
    return candidate.gate.averagePercentile < current.gate.averagePercentile ? candidate : current;
  }
  return candidate.findings.length < current.findings.length ? candidate : current;
}

function blank(best: Attempt | null, revisions: number, reason: string): DraftOutcome {
  return {
    status: "blank",
    draft: {
      text: best && best.problems.length === 0 ? best.text.slice(0, MAX_DRAFT_CHARS) : "",
      gate: best?.gate ? summary(best.gate, revisions) : null,
      reason: reason.slice(0, 500)
    }
  };
}

function summary(gate: VoiceGateResult, revisions: number): VoiceGateSummary {
  return { passed: gate.passed, averagePercentile: gate.averagePercentile, targetAverage: gate.targetAverage, detectors: gate.detectors, revisions };
}

function draftingInstructions(corpus: VoiceCorpus): string {
  return [
    "You draft one answer to an internship application question in the candidate's own writing voice.",
    "Return JSON: {\"insufficientMaterial\": boolean, \"text\": string, \"claims\": [{\"sentence\": string, \"sources\": [ids]}]}.",
    "Facts: use only candidateMaterial (cite its ids) and the posting (cite \"posting\"). Never invent experiences, skills, metrics, dates, opinions, or motives. If the material cannot honestly answer the question, set insufficientMaterial to true and leave text empty.",
    "List every factual sentence in claims with the ids that support it.",
    "styleExamples are private style evidence only: reproduce reasoning, cadence, and rhetorical movement, never their subject matter, anecdotes, facts, or any distinctive phrase. Do not copy eight or more consecutive words from them.",
    "Plain prose, no headings or lists, usually 120-250 words unless the question states a limit; respect any stated limit.",
    "The answer must be specific to this company and role: it must fail if the company or role were swapped for another.",
    "## Voice profile", corpus.voiceProfile,
    "## Category guide", categoryGuideSection(corpus.categoryGuide, CATEGORY),
    "## Authorship gate", corpus.authorshipGate
  ].join("\n\n");
}

function revisionInput(input: string, previous: Attempt, corpus: VoiceCorpus): string {
  const feedback = [
    ...previous.problems,
    ...previous.findings.map((finding) => `Style audit (${finding.check}): ${finding.message}`),
    ...(previous.gate && !previous.gate.passed ? [
      `The local voice gate did not pass: average AI-likeness percentile ${previous.gate.averagePercentile.toFixed(1)} (target ${previous.gate.targetAverage.toFixed(1)}); ` +
      Object.entries(previous.gate.detectors).map(([name, result]) => `${name} ${result.passed ? "passed" : "failed"}`).join(", ") + ".",
      "Revise only where the voice profile or audit rubric identifies a real mismatch (generic structure, symmetry, repetitive transitions, uniform cadence, vague reasoning). Keep every fact and its citations."
    ] : [])
  ];
  return JSON.stringify({
    task: "Revise the previous draft to fix the listed problems while keeping it grounded and in the candidate's voice.",
    previousDraft: previous.text,
    problems: feedback,
    auditRubric: corpus.auditRubric,
    original: JSON.parse(input) as unknown
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The candidate's own material a draft may cite: approved resume entries,
 * allowed current evidence, and education. Facts (dates, authorization,
 * channel-scoped graduation) are deliberately excluded.
 */
export function draftSourcesFor(database: DatabaseSync, candidateId: string): DraftSource[] {
  const sources: DraftSource[] = [];
  for (const entry of listResumeEntries(database, candidateId)) {
    if (entry.archivedAt || entry.current.reviewStatus !== "APPROVED") continue;
    const { title, role, location, dateText, bullets } = entry.current;
    sources.push({ id: `resume:${entry.id}`, text: [title, role, location, dateText, ...bullets].filter(Boolean).join(" | ") });
  }
  for (const project of listProjectEvidenceProfiles(database, candidateId)) {
    for (const claim of project.claims) {
      if (claim.reviewStatus === "ALLOWED" && claim.freshness === "CURRENT") {
        sources.push({ id: `evidence:${claim.id}`, text: `${project.name}: ${claim.text}` });
      }
    }
  }
  const profile = getCandidate(database, candidateId);
  const education = [profile?.degree, profile?.school].filter(Boolean).join(", ");
  if (education) sources.push({ id: "profile:education", text: education });
  return sources;
}

/**
 * Replaces pauses on required open-ended questions (and template package
 * answers to open-ended questions) with voice drafts. A draft fills a field
 * only after the voice gate passes; otherwise the field pauses blank with the
 * best version attached for the candidate to write from.
 */
export async function applyVoiceDrafts(
  plan: { decisions: FillDecision[]; pauses: PauseRecord[] },
  form: RecognizedForm,
  context: { drafter: VoiceDrafter; posting: JobPosting; sources: DraftSource[] }
): Promise<{ decisions: FillDecision[]; pauses: PauseRecord[] }> {
  const decisions: FillDecision[] = [];
  const pauses = [...plan.pauses];
  for (const decision of plan.decisions) {
    const field = form.fields.find((entry) => entry.id === decision.fieldId);
    const pause = pauses.find((entry) => entry.fieldId === decision.fieldId);
    const draftable = field && isDraftableQuestion(field) && (
      (decision.action === "pause" && pause && !pause.safeguard && !pause.sensitive && !pause.upload && !pause.suggestedKey) ||
      (decision.action === "fill" && decision.basis?.kind === "package-answer")
    );
    if (!field || !draftable) { decisions.push(decision); continue; }
    const outcome = await context.drafter({
      question: field.label,
      companyName: context.posting.companyName,
      title: context.posting.title,
      postingText: context.posting.snapshot.normalizedText,
      sources: context.sources,
      jobId: context.posting.id
    });
    const index = pauses.findIndex((entry) => entry.fieldId === field.id);
    if (outcome.status === "filled") {
      if (index >= 0) pauses.splice(index, 1);
      decisions.push({
        fieldId: field.id, action: "fill", value: outcome.text, basis: { kind: "voice_draft", gate: outcome.gate },
        reason: `Drafted in your voice; the voice gate passed (average ${outcome.gate.averagePercentile.toFixed(1)}% vs target ${outcome.gate.targetAverage.toFixed(0)}%, ${outcome.gate.revisions} revision${outcome.gate.revisions === 1 ? "" : "s"}).`,
        pause: null
      });
      continue;
    }
    const question = `Write your answer to "${field.label}". ${outcome.draft.text ? "The best voice draft is shown for reference; it did not fill the field." : ""}`.trim().slice(0, 500);
    const pauseDecision: FillDecision = {
      fieldId: field.id, action: "pause", value: null, basis: null,
      reason: (outcome.draft.reason ?? "Left blank for you to write.").slice(0, 500),
      pause: { question, key: null, scope: null, safeguard: false }
    };
    decisions.push(pauseDecision);
    const record: PauseRecord = {
      fieldId: field.id, label: field.label, question, suggestedKey: null, suggestedScope: null,
      safeguard: false, sensitive: false, upload: false, status: "open", answer: null, draft: outcome.draft
    };
    if (index >= 0) pauses[index] = record; else pauses.push(record);
  }
  return { decisions, pauses };
}
