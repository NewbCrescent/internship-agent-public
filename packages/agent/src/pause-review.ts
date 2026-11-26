import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  getCurrentFact,
  getCurrentFacts,
  getJobPosting,
  LOCAL_CANDIDATE_ID,
  logApplicationEvent,
  questionAliasStoreAvailable,
  recordQuestionAlias,
  recordModelInvocation
} from "@internship-agent/db";
import {
  aiReviewMatchReason,
  candidateFactKeySchema,
  COURSEWORK_FACT_KEY,
  factDefinitions,
  factGroupsOf,
  formatFactValue,
  isDraftableQuestion,
  matchOfferedOption,
  normalizeAnswerText,
  questionSaveBlocker,
  scopeKey,
  STANDARD_ANSWER_KEYS,
  type AtsKind,
  type BrowserField,
  type CandidateFact,
  type CandidateFactKey,
  type FactScope,
  type FillDecision,
  type PauseRecord,
  type QuestionContext,
  type RecognizedForm
} from "@internship-agent/domain";

import { OpenAiCompatibleProvider } from "./model/openai-compatible-provider";
import type { ModelProvider, ModelTask } from "./model/provider";
import { pauseReviewEligible } from "./pause-recheck";
import { DeterministicQuestionMapper, type SemanticQuestionMapper } from "./question-mapper";
import { answeredPauseDecision } from "./question-answers";

/**
 * The AI review of a pause batch (Track 45): when a run pauses on questions
 * the deterministic re-check could not answer, one model call looks at the
 * batch. Its output is a suggestion only; deterministic guardrails decide.
 * A saved-answer match is applied only when every check passes (it then does
 * not hold auto-submit, the candidate's decision of 2026-11-26, and the
 * auto-submit approval names the question by label); anything
 * else waits for the candidate with the model's reason added; a suggested
 * draft for an open-ended question is shown, never filled or stored. Any
 * model failure leaves the pauses exactly as they were. Each reviewed
 * question also gets a timeline line with its verdict, the fact key, and the
 * refusing check (and the mapper's result for a mapped question), never a value.
 *
 * What is sent: the posting's company, title, and places; each question's
 * label, kind, and options; and the saved candidate facts the review may
 * match, where only standard-sensitivity values are sent and sensitive ones
 * appear as "saved". Nothing about the protected self-identification
 * categories is sent in any form (no key, description, value, or marker).
 * Never the candidate's name, contact details, student ID, question-memory
 * answers, secrets, or browser state.
 */

export const PAUSE_REVIEW_TASK: ModelTask = "application.pause_review";

export type PauseReviewRequest = {
  jobId: string;
  atsKind: AtsKind;
  posting: { companyName: string; title: string; locations: string[] };
  context: QuestionContext;
  form: RecognizedForm;
  decisions: FillDecision[];
  pauses: PauseRecord[];
  sourceRunId: string | null;
};

/**
 * Returns the decisions and pauses after the review. A matched pause comes
 * back answered (start drops it; continue and Workday keep it answered).
 */
export type PauseReviewer = (request: PauseReviewRequest) => Promise<{ decisions: FillDecision[]; pauses: PauseRecord[] }>;

export const PAUSE_REVIEW_INSTRUCTIONS = [
  "You review questions an internship application paused on, for a candidate who answers them later.",
  "Input JSON: posting (company, title, locations), questions (id, label, kind, options), and savedAnswers (key, description, scope, value; a value of \"saved\" means the candidate saved an answer whose value you are not shown).",
  "Return JSON: {\"reviews\": [{\"id\": string, \"verdict\": \"saved_answer\" | \"needs_candidate\" | \"draft\", \"key\": string | null, \"option\": string | null, \"reason\": string, \"draft\": string | null}]}, exactly one review per question id.",
  "saved_answer: only when one savedAnswers key answers the question exactly as asked (the same meaning and the same scope); set key to that key, and option to the offered option it maps to (null for a text box).",
  "needs_candidate: otherwise; reason is one plain sentence saying what the candidate must decide.",
  "draft: only for an open-ended writing prompt; draft is a short suggestion that uses only the posting and savedAnswers and claims no experience, skill, or fact that is not given (null if you cannot).",
  "Never invent facts about the candidate, never choose an option that is not offered, and never answer for the candidate a question savedAnswers does not settle."
].join("\n");

export const pauseReviewOutputSchema = z.object({
  reviews: z.array(z.object({
    id: z.string().max(10),
    verdict: z.enum(["saved_answer", "needs_candidate", "draft"]),
    key: z.string().max(80).nullable(),
    option: z.string().max(200).nullable(),
    reason: z.string().max(300),
    draft: z.string().max(2000).nullable()
  })).max(60)
});
export type PauseReviewOutput = z.infer<typeof pauseReviewOutputSchema>;
export type PauseReview = PauseReviewOutput["reviews"][number];

/** The deterministic check that refused a saved-answer match (shown on the pause as "did not pass the checks (<check>)"). */
export type PauseReviewCheck =
  | "unknown key" | "sensitive answer" | "standard answer" | "mapped question" | "statement of fact"
  | "never reused" | "scope" | "no options" | "no matching option" | "option disagrees" | "field kind"
  | "no wording store" | "field fit";

/** What became of one reviewed question: labels, fact keys, and check names only; never an answer, saved value, option, reason, or draft. */
export type PauseReviewDiagnostic = {
  id: string;
  label: string;
  verdict: PauseReview["verdict"] | "none";
  /** The model's key, only when it is one of the saved-answer keys sent (so never protected, and never the model's raw text). */
  key: CandidateFactKey | null;
  /** The check that refused a saved_answer verdict. */
  check: PauseReviewCheck | null;
  /** For a "mapped question" refusal: the mapper's status with its key (MAPPED) or policy (BLOCKED). */
  mapper: string | null;
  outcome: "matched" | "refused" | "waits" | "draft kept" | "no review";
};

export type SavedAnswerForReview = { key: CandidateFactKey; description: string; scope?: string; value: string };

const DRAFT_REASON = "AI review suggestion; not sent. Use it with pnpm run:answer --use-draft, or write your own.";

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The saved facts the review may match: reusable catalog facts (not
 * coursework, not the standard legal answers, not protected
 * self-identification facts), with values only for standard-sensitivity
 * facts; sensitive ones read "saved". Protected self-identification
 * categories are never sent in any form: no key, description, value, or
 * saved or not-saved marker.
 */
export function pauseReviewSavedAnswers(database: DatabaseSync, candidateId: string): SavedAnswerForReview[] {
  const answers: SavedAnswerForReview[] = [];
  const facts = getCurrentFacts(database, candidateId);
  for (const fact of facts) {
    const definition = factDefinitions[fact.key];
    if (
      fact.reusePolicy !== "auto"
      || fact.key === COURSEWORK_FACT_KEY
      || STANDARD_ANSWER_KEYS.has(fact.key)
      || definition.sensitivity === "protected"
    ) continue;
    answers.push({
      key: fact.key,
      description: definition.label,
      scope: scopeKey(fact.scope),
      value: definition.sensitivity === "standard" ? formatFactValue(fact.value) : "saved"
    });
  }
  return answers;
}

type Eligible = { id: string; pause: PauseRecord; field: BrowserField };

/** The open question pauses of this batch the review may look at, numbered q1, q2, … in form order. */
export function eligiblePauses(request: Pick<PauseReviewRequest, "form" | "decisions" | "pauses">): Eligible[] {
  const fields = new Map(request.form.fields.map((field) => [field.id, field]));
  const paused = new Set(request.decisions.filter((decision) => decision.action === "pause").map((decision) => decision.fieldId));
  const eligible: Eligible[] = [];
  for (const pause of request.pauses) {
    const field = fields.get(pause.fieldId);
    if (pause.status !== "open" || !paused.has(pause.fieldId) || !field || !pauseReviewEligible(pause, field)) continue;
    eligible.push({ id: `q${eligible.length + 1}`, pause, field });
  }
  return eligible;
}

/** The model's input for one batch; pure. */
export function buildPauseReviewInput(
  request: Pick<PauseReviewRequest, "posting">,
  eligible: readonly Eligible[],
  savedAnswers: readonly SavedAnswerForReview[]
): string {
  return JSON.stringify({
    posting: { company: request.posting.companyName, title: request.posting.title, locations: request.posting.locations },
    questions: eligible.map(({ id, field }) => ({
      id,
      label: field.label,
      kind: field.widget === "autocomplete" ? "autocomplete" : field.kind,
      options: (field.options ?? []).slice(0, 50).map((option) => clip(option, 120))
    })),
    savedAnswers
  });
}

export type PauseReviewDeps = {
  database: DatabaseSync;
  candidateId: string;
  mapper: SemanticQuestionMapper;
};

type Applied = { decisions: FillDecision[]; pauses: PauseRecord[]; matched: number; drafts: number; diagnostics: PauseReviewDiagnostic[] };

/** The model's key when it is one of the keys sent; otherwise null (the model's own text is never logged). */
function sentKey(key: string | null, sent: readonly SavedAnswerForReview[]): CandidateFactKey | null {
  const parsed = candidateFactKeySchema.safeParse(key);
  return parsed.success && sent.some((answer) => answer.key === parsed.data) ? parsed.data : null;
}

/** One timeline line for one reviewed question; labels, keys, and check names only. */
export function pauseReviewDiagnosticDetail(diagnostic: PauseReviewDiagnostic): string {
  const verdict = diagnostic.verdict === "none"
    ? "no review returned"
    : `verdict ${diagnostic.verdict}${diagnostic.verdict === "saved_answer" ? `, ${diagnostic.key ? `key ${diagnostic.key}` : "no usable key"}` : ""}`;
  const outcome = diagnostic.outcome === "matched" ? "matched"
    : diagnostic.outcome === "refused" ? `refused by the "${diagnostic.check ?? "unknown"}" check${diagnostic.mapper ? ` (mapper: ${diagnostic.mapper})` : ""}`
    : diagnostic.outcome === "draft kept" ? "draft kept, not sent"
    : "waits for you";
  return `AI review of "${clip(diagnostic.label, 150)}" (${diagnostic.id}): ${verdict}; ${outcome}.`.slice(0, 1000);
}

/** The first current fact of this key whose scope applies here: the company's, then the posting country's, then the global one. */
function applicableFact(database: DatabaseSync, candidateId: string, key: CandidateFactKey, context: QuestionContext): { fact: CandidateFact; scope: FactScope } | null {
  const allowed = factDefinitions[key].allowedScopes as FactScope["kind"][];
  const scopes: FactScope[] = [];
  if (allowed.includes("company") && context.companyName) scopes.push({ kind: "company", name: context.companyName });
  if (allowed.includes("country") && context.postingCountryCode) scopes.push({ kind: "country", code: context.postingCountryCode });
  if (allowed.includes("global")) scopes.push({ kind: "global" });
  for (const scope of scopes) {
    const fact = getCurrentFact(database, candidateId, key, scope);
    if (fact) return fact.reusePolicy === "auto" ? { fact, scope } : null;
  }
  return null;
}

const OPTION_KINDS = new Set(["select", "radio"]);

/** The answer text this fact gives this field, or the name of the check it fails. */
function fieldAnswer(field: BrowserField, value: boolean | string, valueType: string, modelOption: string | null): { text: string } | { failed: PauseReviewCheck } {
  const shown = formatFactValue(value);
  const listed = OPTION_KINDS.has(field.kind) || field.widget === "autocomplete" || (field.kind === "checkbox" && (field.options?.length ?? 0) >= 2);
  if (listed) {
    if (!field.options?.length) return { failed: "no options" };
    const option = matchOfferedOption(field.options, shown);
    if (!option) return { failed: "no matching option" };
    if (modelOption !== null && normalizeAnswerText(modelOption) !== normalizeAnswerText(option)) return { failed: "option disagrees" };
    return { text: option };
  }
  if (field.kind === "checkbox") return typeof value === "boolean" ? { text: shown } : { failed: "field kind" };
  if (["text", "textarea", "url", "number"].includes(field.kind)) return valueType === "date" ? { failed: "field kind" } : { text: shown };
  return { failed: "field kind" };
}

/**
 * The deterministic guardrails over the model's reviews; every check must
 * pass before a saved-answer match is applied. Pure apart from reading the
 * saved facts, the timeline lines, and the recorded wordings it writes for
 * applied matches.
 */
export async function applyPauseReview(
  reviews: readonly PauseReview[],
  request: PauseReviewRequest,
  eligible: readonly Eligible[],
  sent: readonly SavedAnswerForReview[],
  deps: PauseReviewDeps
): Promise<Applied> {
  let decisions = request.decisions;
  let pauses = request.pauses;
  let matched = 0;
  let drafts = 0;
  const byId = new Map(eligible.map((entry) => [entry.id, entry]));
  const done = new Set<string>();
  const diagnostics = new Map<string, PauseReviewDiagnostic>(eligible.map((entry) => [
    entry.id,
    { id: entry.id, label: entry.field.label, verdict: "none", key: null, check: null, mapper: null, outcome: "no review" }
  ]));
  const mark = (id: string, patch: Partial<PauseReviewDiagnostic>) => {
    const current = diagnostics.get(id);
    if (current) diagnostics.set(id, { ...current, ...patch });
  };
  const status = getJobPosting(deps.database, request.jobId)?.status ?? "APPLYING";
  const log = (detail: string) => logApplicationEvent(deps.database, { jobId: request.jobId, fromStatus: status, toStatus: status, detail: detail.slice(0, 1000) });
  const replacePause = (fieldId: string, next: PauseRecord) => {
    pauses = pauses.map((pause) => (pause.fieldId === fieldId ? next : pause));
  };
  const note = (entry: Eligible, reason: string) => {
    const current = pauses.find((pause) => pause.fieldId === entry.pause.fieldId) ?? entry.pause;
    const base = current.question.split(" AI review: ")[0]!;
    replacePause(entry.pause.fieldId, { ...current, question: `${base} AI review: ${clip(reason, 200)}`.slice(0, 500) });
  };
  for (const review of reviews) {
    const entry = byId.get(review.id);
    if (!entry || done.has(review.id)) continue;
    done.add(review.id);
    mark(review.id, { verdict: review.verdict, key: review.verdict === "saved_answer" ? sentKey(review.key, sent) : null });
    const { pause, field } = entry;
    if (review.verdict === "saved_answer") {
      const failed = await savedAnswerCheck(review, entry, request, sent, deps);
      if ("failed" in failed) {
        mark(review.id, { outcome: "refused", check: failed.failed, mapper: failed.mapper ?? null });
        note(entry, `AI review suggested a saved answer, but it did not pass the checks (${failed.failed}); answer it yourself.`);
        continue;
      }
      const { key, scope, text } = failed;
      const decision = answeredPauseDecision(field, text, { kind: "fact", key, scope: scopeKey(scope) });
      if (!decision) {
        mark(review.id, { outcome: "refused", check: "field fit" });
        note(entry, "AI review suggested a saved answer, but it did not pass the checks (field fit); answer it yourself.");
        continue;
      }
      mark(review.id, { outcome: "matched" });
      decisions = decisions.map((current) => (current.fieldId === field.id ? { ...decision, reason: aiReviewMatchReason(field.label) } : current));
      replacePause(field.id, { ...pause, status: "answered", answer: text, suggestedKey: key, suggestedScope: scopeKey(scope) });
      matched += 1;
      log(`AI review matched '${clip(field.label, 150)}' to saved answer ${key} (${scopeKey(scope)}).`);
      recordQuestionAlias(deps.database, {
        candidateId: deps.candidateId, wording: pause.label, target: { kind: "fact", factKey: key, scopeKey: scopeKey(scope) },
        atsKind: request.atsKind, fieldKind: pause.fieldKind ?? field.kind, options: field.options ?? [], source: "ai_review", sourceRunId: request.sourceRunId
      });
      continue;
    }
    if (review.verdict === "draft") {
      const text = review.draft?.trim() ?? "";
      if (text && !pause.draft && (field.kind === "textarea" || isDraftableQuestion({ label: field.label, kind: field.kind }))) {
        replacePause(field.id, { ...pause, draft: { text: text.slice(0, 4000), gate: null, reason: DRAFT_REASON, source: "pause_review" } });
        drafts += 1;
        mark(review.id, { outcome: "draft kept" });
        continue;
      }
    }
    mark(review.id, { outcome: "waits" });
    if (review.reason.trim()) note(entry, review.reason);
  }
  return { decisions, pauses, matched, drafts, diagnostics: eligible.flatMap((entry) => diagnostics.get(entry.id) ?? []) };
}

async function savedAnswerCheck(
  review: PauseReview,
  entry: Eligible,
  request: PauseReviewRequest,
  sent: readonly SavedAnswerForReview[],
  deps: PauseReviewDeps
): Promise<{ key: CandidateFactKey; scope: FactScope; text: string } | { failed: PauseReviewCheck; mapper?: string }> {
  const { field } = entry;
  const parsed = candidateFactKeySchema.safeParse(review.key);
  if (!parsed.success || !sent.some((answer) => answer.key === parsed.data)) return { failed: "unknown key" };
  const key = parsed.data;
  const definition = factDefinitions[key];
  if (definition.sensitivity !== "standard") return { failed: "sensitive answer" };
  if (key === COURSEWORK_FACT_KEY || STANDARD_ANSWER_KEYS.has(key)) return { failed: "standard answer" };
  const mapping = await deps.mapper.map(field.label, { ...request.context, fieldKind: field.kind });
  if (mapping.status !== "UNMAPPED") {
    return { failed: "mapped question", mapper: mapping.status === "MAPPED" ? `MAPPED ${mapping.key}` : mapping.status === "BLOCKED" ? `BLOCKED ${mapping.policy}` : mapping.status };
  }
  if (factGroupsOf(field.label).length > 0) return { failed: "statement of fact" };
  if (questionSaveBlocker({ label: field.label, fieldId: field.id, fieldKind: field.kind, companyName: request.context.companyName ?? null })) return { failed: "never reused" };
  const found = applicableFact(deps.database, deps.candidateId, key, request.context);
  if (!found) return { failed: "scope" };
  const answer = fieldAnswer(field, found.fact.value, definition.valueType, review.option);
  if ("failed" in answer) return answer;
  // The match must be repeatable from its recorded wording, so later continues keep it marked as an AI review match.
  if (!questionAliasStoreAvailable(deps.database)) return { failed: "no wording store" };
  return { key, scope: found.scope, text: answer.text };
}

/**
 * A reviewer for one run invocation (start, continue, or one Workday walk):
 * at most one model call per distinct batch, and at most `maxCalls` calls.
 */
export function createPauseReviewer(deps: {
  provider: ModelProvider;
  database: DatabaseSync;
  candidateId?: string;
  mapper?: SemanticQuestionMapper;
  maxCalls?: number;
}): PauseReviewer {
  const reviewed = new Set<string>();
  const maxCalls = deps.maxCalls ?? 3;
  let calls = 0;
  const guard: PauseReviewDeps = {
    database: deps.database,
    candidateId: deps.candidateId ?? LOCAL_CANDIDATE_ID,
    mapper: deps.mapper ?? new DeterministicQuestionMapper()
  };
  return async (request) => {
    const unchanged = { decisions: request.decisions, pauses: request.pauses };
    const eligible = eligiblePauses(request);
    if (eligible.length === 0) return unchanged;
    const signature = eligible.map(({ pause }) => `${pause.fieldId}\u0000${pause.label}`).sort().join("\u0001");
    if (reviewed.has(signature) || calls >= maxCalls) return unchanged;
    reviewed.add(signature);
    calls += 1;
    const sent = pauseReviewSavedAnswers(deps.database, guard.candidateId);
    const input = buildPauseReviewInput(request, eligible, sent);
    const status = getJobPosting(deps.database, request.jobId)?.status ?? "APPLYING";
    let output: PauseReviewOutput;
    let usage: { durationMs: number; inputTokens: number; outputTokens: number };
    try {
      const result = await deps.provider.complete({
        task: PAUSE_REVIEW_TASK, tier: "cheap", jobId: request.jobId, instructions: PAUSE_REVIEW_INSTRUCTIONS, input,
        schema: pauseReviewOutputSchema, maxOutputTokens: 6000, reasoningEffort: "low"
      });
      recordModelInvocation(deps.database, {
        task: PAUSE_REVIEW_TASK, tier: "cheap", model: result.model, jobId: request.jobId, inputTokens: result.inputTokens,
        outputTokens: result.outputTokens, durationMs: result.durationMs, outcome: "succeeded"
      });
      output = result.value;
      usage = { durationMs: result.durationMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    } catch (error) {
      recordModelInvocation(deps.database, {
        task: PAUSE_REVIEW_TASK, tier: "cheap", model: "unavailable", jobId: request.jobId, inputTokens: 0, outputTokens: 0, durationMs: 0, outcome: "failed"
      });
      const name = error instanceof Error ? error.name : "Error";
      logApplicationEvent(deps.database, {
        jobId: request.jobId, fromStatus: status, toStatus: status,
        detail: `AI review could not run (${clip(name, 60)}); the questions wait for you as before.`
      });
      return unchanged;
    }
    const applied = await applyPauseReview(output.reviews, request, eligible, sent, guard);
    logApplicationEvent(deps.database, {
      jobId: request.jobId, fromStatus: status, toStatus: status,
      detail: `AI review looked at ${eligible.length} open question(s): ${applied.matched} matched saved answers, ${eligible.length - applied.matched} wait for you, ${applied.drafts} suggested drafts (${Math.round(usage.durationMs)} ms, ${Math.round(usage.inputTokens)} input and ${Math.round(usage.outputTokens)} output tokens).`
    });
    for (const diagnostic of applied.diagnostics) {
      logApplicationEvent(deps.database, { jobId: request.jobId, fromStatus: status, toStatus: status, detail: pauseReviewDiagnosticDetail(diagnostic) });
    }
    return { decisions: applied.decisions, pauses: applied.pauses };
  };
}

/**
 * The default reviewer: the configured model (tier cheap), or none when no
 * model is configured or INTERNSHIP_AGENT_PAUSE_REVIEW=0 turns it off.
 */
export function createDefaultPauseReviewer(options: {
  database: DatabaseSync;
  candidateId?: string;
  env?: Record<string, string | undefined>;
}): PauseReviewer | null {
  const env = options.env ?? process.env;
  if (env.INTERNSHIP_AGENT_PAUSE_REVIEW?.trim() === "0") return null;
  const provider = new OpenAiCompatibleProvider({ timeoutMs: 90_000 });
  if (!provider.available) return null;
  return createPauseReviewer({ provider, database: options.database, candidateId: options.candidateId });
}
