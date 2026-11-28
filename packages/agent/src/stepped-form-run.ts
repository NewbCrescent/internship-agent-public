import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  getCurrentPackage,
  getJobPosting,
  LOCAL_CANDIDATE_ID,
  saveBrowserRun,
  setJobStatus,
  updateBrowserRun,
  type CurrentPackage
} from "@internship-agent/db";
import {
  capturePostSubmitEvidence,
  challengePause,
  choicesNotTaken,
  formChangedPause,
  hasApplicationFields,
  hasSiteNavigation,
  hasSteppedWalk,
  hasTranscriptField,
  invalidFieldPauses,
  planAutofill,
  postSubmitEvidenceOf,
  recognizeCurrentForm,
  runTraceOf,
  submitAndConfirm,
  submitTargetHoldReason,
  submitTargetPause,
  SubmissionChallenged,
  SubmissionHeld,
  SubmissionNeedsInput,
  unfilledPause,
  walkSteppedForm,
  type ApplyDecisionsOptions,
  type AtsFlow,
  type BrowserPage,
  type FieldResolution,
  type PlannerInputs,
  type PostSubmitEvidence,
  type SteppedPage,
  type SteppedStepPlan,
  type SteppedWalkResult
} from "@internship-agent/browser";
import {
  boundDecisionText,
  boundPauseQuestion,
  parseSteppedFieldId,
  steppedFieldId,
  type ApplicationChannel,
  type ApplicationProfile,
  type AtsKind,
  type BrowserRun,
  type FillDecision,
  type JobPosting,
  type PauseRecord,
  type QuestionContext,
  type RecognizedForm,
  type StandingConsentSettings
} from "@internship-agent/domain";

import { currentCandidateDocument } from "./base-resume-service";
import type { RunReport } from "./browser-orchestrator";
import { yearHoldMessage } from "./company-policy";
import { logAliasHits, settleAliasHits, type AliasHit } from "./pause-recheck";
import type { PauseReviewer } from "./pause-review";
import { answeredPauseDecision } from "./question-answers";
import { AutomaticRunStopped } from "./run-errors";
import { postingLocationNames, postingQuestionContext } from "./saved-answers";
import { logStandingAcceptances } from "./standing-consent";
import { fillStops, savePostSubmitEvidenceQuietly, saveStopEvidenceQuietly } from "./submit-evidence";
import { applyVoiceDrafts, draftSourcesFor, type VoiceDrafter } from "./voice-drafting";

/**
 * Track 74: runs of a several-page form on a site without an adapter, walked
 * step by step (packages/browser/src/stepped-form.ts). Start and continue
 * walk to the last step and stop there; submit re-walks to the last step with
 * the candidate's recorded approval only, checks again, and clicks the form's
 * own submit control there. The auto-submit policy never submits these runs
 * (autoSubmitBlockers' stepped-form blocker, and submitSteppedRun refuses a
 * policy approval). Field ids are `step-<n>::<id>`.
 */

/** Orchestrator helpers the stepped run reuses, passed in to keep one source of truth (as WorkdayRunDeps). */
export type SteppedRunDeps = {
  resolveFields(form: RecognizedForm, context: QuestionContext, hits: AliasHit[]): Promise<Map<string, FieldResolution>>;
  plannerInputs(input: {
    resolutions: Map<string, FieldResolution>;
    packageAnswers: Array<{ prompt: string; text: string }>;
    variantId: string | null;
    transcriptDocumentId: string | null;
    profile: ApplicationProfile;
    standing: StandingConsentSettings;
    postingLocations: string[];
  }): PlannerInputs;
  prepareUploads(source: { jobId: string; variantId: string | null; channel: ApplicationChannel | null }, decisions: FillDecision[]): Promise<(decision: FillDecision) => string | null>;
  withUploadedResume(decisions: FillDecision[], profile: ApplicationProfile): FillDecision[];
  applyOptions(run: { id: string; jobId: string }, page: BrowserPage): ApplyDecisionsOptions;
  recordSubmission(jobId: string, labels: Record<string, string>): Promise<void>;
};

type SteppedContext = {
  database: DatabaseSync;
  deps: SteppedRunDeps;
  jobId: string;
  candidateId: string;
  posting: JobPosting;
  packageAnswers: Array<{ prompt: string; text: string }>;
  variantId: string | null;
  profile: ApplicationProfile;
  channel: ApplicationChannel | null;
  lock: ApplicationProfile | null;
  automatic: boolean;
  standing: StandingConsentSettings;
  mode: "start" | "continue" | "submit";
  drafter: VoiceDrafter | null;
  reviewer: PauseReviewer | null;
  /** The candidate's answered pauses (answer not null), by step-prefixed id. */
  answers: Map<string, PauseRecord>;
  /** The run's own decisions, by step-prefixed id; empty at start. */
  earlier: Map<string, FillDecision>;
  runId: string;
  atsKind: AtsKind;
  page: BrowserPage;
};

const VALUE_ACTIONS = new Set(["fill", "choose", "check"]);
/** Decisions that act on the page or ask the candidate: a walk with none of them never reached a form. */
const ACTED = new Set(["fill", "choose", "check", "upload", "keep", "pause"]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

function uploadedBaseResumeId(decisions: FillDecision[]): string | null {
  for (const decision of decisions) {
    if (decision.action === "upload" && decision.basis?.kind === "base_resume") return decision.basis.baseResumeId;
  }
  return null;
}

function countApplied(decisions: FillDecision[]): number {
  return decisions.filter((decision) => ["fill", "choose", "check", "upload"].includes(decision.action)).length;
}

function stopError(automatic: boolean, reason: string): Error {
  return automatic ? new AutomaticRunStopped(reason) : new Error(reason);
}

/** Plans one step with the same inputs as the one-page path, then the candidate's answers and the run's own earlier decisions. */
async function planSteppedStep(ctx: SteppedContext, step: number, form: RecognizedForm): Promise<SteppedStepPlan> {
  const { database, deps, posting } = ctx;
  let transcriptDocumentId: string | null = null;
  if (hasTranscriptField(form.fields)) {
    if (ctx.profile !== "transcript") {
      const reason = ctx.lock === "default"
        ? yearHoldMessage(database, ctx.candidateId, posting.companyName)
        : `Step ${step} of the application at ${hostOf(ctx.page.url())} asks for your transcript; the agent fills a several-page form with one application profile and does not switch to the 2029 profile partway. Finish this application in your own browser.`;
      throw stopError(ctx.automatic, reason);
    }
    transcriptDocumentId = currentCandidateDocument("transcript", database, ctx.candidateId)?.id ?? null;
    if (!transcriptDocumentId) throw new Error("This application asks for your transcript. Upload it on the profile page, then start the run again.");
  }
  const context: QuestionContext = { ...(ctx.channel ? { applicationChannel: ctx.channel } : {}), ...postingQuestionContext(posting) };
  const aliasHits: AliasHit[] = [];
  const resolutions = await deps.resolveFields(form, context, aliasHits);
  const plan = planAutofill(form, deps.plannerInputs({
    resolutions,
    packageAnswers: ctx.packageAnswers,
    variantId: ctx.variantId,
    transcriptDocumentId,
    profile: ctx.profile,
    standing: ctx.standing,
    postingLocations: postingLocationNames(posting)
  }));
  const fields = new Map(form.fields.map((field) => [field.id, field]));
  const settled = new Set<string>();
  let decisions = plan.decisions.map((decision): FillDecision => {
    const field = fields.get(decision.fieldId);
    if (!field) return decision;
    const prefixed = steppedFieldId(step, decision.fieldId);
    const answered = ctx.answers.get(prefixed);
    if (answered && answered.answer !== null) {
      const filled = answeredPauseDecision(
        field,
        answered.answer,
        answered.suggestedKey && answered.suggestedScope ? { kind: "fact", key: answered.suggestedKey, scope: answered.suggestedScope } : null
      );
      // An answer that fits none of the field's options keeps the planner's decision, so its pause opens again.
      if (!filled) return decision;
      settled.add(decision.fieldId);
      return filled;
    }
    const earlier = ctx.earlier.get(prefixed);
    if (decision.action === "pause" && earlier && VALUE_ACTIONS.has(earlier.action) && earlier.value !== null) {
      // The run keeps what it already decided there (an approved voice draft, an AI review match).
      settled.add(decision.fieldId);
      return { ...earlier, fieldId: decision.fieldId };
    }
    return decision;
  });
  let pauses = plan.pauses.filter((pause) => !settled.has(pause.fieldId));
  // The 2029 profile prints the tailored resume with the 2029 graduation date, as the one-page path says.
  if (ctx.channel) {
    decisions = decisions.map((decision): FillDecision => decision.action === "upload" && decision.basis?.kind === "variant"
      ? { ...decision, reason: "Uploads your tailored resume printed with your 2029 graduation date." }
      : decision);
  }
  const aliased = settleAliasHits(decisions, aliasHits);
  decisions = aliased.decisions;
  if (ctx.mode !== "submit") logAliasHits(database, ctx.jobId, aliased.used);
  if (ctx.drafter) {
    ({ decisions, pauses } = await applyVoiceDrafts({ decisions, pauses }, form, {
      drafter: ctx.drafter, posting, sources: draftSourcesFor(database, ctx.candidateId)
    }));
  }
  if (ctx.reviewer) {
    ({ decisions, pauses } = await ctx.reviewer({
      jobId: ctx.jobId, atsKind: ctx.atsKind,
      posting: { companyName: posting.companyName, title: posting.title, locations: postingLocationNames(posting) },
      context, form, decisions, pauses, sourceRunId: ctx.mode === "start" ? null : ctx.runId
    }));
  }
  decisions = deps.withUploadedResume(decisions, ctx.profile);
  return {
    decisions,
    pauses,
    safeguardHalt: plan.safeguardHalt,
    uploadPathFor: await deps.prepareUploads({ jobId: ctx.jobId, variantId: ctx.variantId, channel: ctx.channel }, decisions),
    applyOptions: deps.applyOptions({ id: ctx.runId, jobId: ctx.jobId }, ctx.page)
  };
}

/** The safeguard pause a held walk leaves on a saved run (modeled on submitTargetPause). */
function steppedHoldPause(step: number, reason: string): { decision: FillDecision; pause: PauseRecord } {
  const question = `The application stopped at step ${step}: ${reason}. Finish this application in your own browser.`.slice(0, 500);
  const fieldId = steppedFieldId(step, "stepped-hold");
  return {
    decision: { fieldId, action: "pause", value: null, basis: null, reason: question, pause: { question, key: null, scope: null, safeguard: true } },
    pause: {
      fieldId, label: `Step ${step}`, question, suggestedKey: null, suggestedScope: null,
      safeguard: true, sensitive: false, upload: false, status: "open", answer: null, draft: null
    }
  };
}

/** Run status, decisions, and pauses after a walk; the run's answered pauses the walk did not ask again are kept. */
function steppedOutcome(walk: SteppedWalkResult, earlierPauses: PauseRecord[]): { status: BrowserRun["status"]; decisions: FillDecision[]; pauses: PauseRecord[] } {
  const current = new Set(walk.pauses.map((pause) => pause.fieldId));
  let pauses = [...earlierPauses.filter((pause) => pause.status === "answered" && !current.has(pause.fieldId)), ...walk.pauses];
  let decisions = walk.decisions;
  const add = (held: { decision: FillDecision; pause: PauseRecord }) => {
    decisions = [...decisions.filter((decision) => decision.fieldId !== held.decision.fieldId), held.decision];
    pauses = [...pauses.filter((pause) => pause.fieldId !== held.pause.fieldId), held.pause];
  };
  const step = walk.steps.at(-1) ?? 1;
  if (walk.outcome === "challenge") add(walk.challenge ? challengePause(walk.challenge) : steppedHoldPause(step, "the page shows a safeguard challenge"));
  if (walk.outcome === "held") add(steppedHoldPause(step, walk.hold ?? "the walk stopped"));
  const open = pauses.some((pause) => pause.status === "open");
  return { status: walk.outcome === "last-page" && !open ? "awaiting-approval" : "paused-needs-input", decisions, pauses };
}

function answeredPauses(pauses: PauseRecord[]): Map<string, PauseRecord> {
  return new Map(pauses.filter((pause) => pause.status === "answered" && pause.answer !== null).map((pause) => [pause.fieldId, pause]));
}

function heldStop(walk: SteppedWalkResult) {
  return { kind: "step-transition" as const, reason: walk.hold ?? "", fieldLabel: `Step ${walk.steps.at(-1) ?? 1}`, region: { kind: "page" as const } };
}

/** Opens the form a run saved and, on a site whose form sits behind a button, walks to it again. */
async function steppedPrelude(page: SteppedPage): Promise<void> {
  const form = await recognizeCurrentForm(page);
  if (hasSiteNavigation(page) && !hasApplicationFields(form.fields)) await page.advanceToApplicationForm();
}

export async function startSteppedRun(
  database: DatabaseSync,
  deps: SteppedRunDeps,
  page: SteppedPage,
  input: {
    jobId: string;
    candidateId: string;
    posting: JobPosting;
    current: CurrentPackage;
    variantId: string;
    automatic: boolean;
    lock: ApplicationProfile | null;
    formUrl: string;
    classification: { kind: AtsKind; confidence: number };
    flow: AtsFlow;
    dataDir: string;
    standing: StandingConsentSettings;
    channel: ApplicationChannel | null;
    profile: ApplicationProfile;
    drafterFactory: () => VoiceDrafter | null;
    reviewerFactory: () => PauseReviewer | null;
  }
): Promise<RunReport> {
  const { jobId, posting, automatic } = input;
  if (input.lock === "default" && input.channel) throw new AutomaticRunStopped(yearHoldMessage(database, input.candidateId, posting.companyName));
  const runId = randomUUID();
  runTraceOf(page)?.setRun(runId);
  const ctx: SteppedContext = {
    database, deps, jobId, candidateId: input.candidateId, posting,
    packageAnswers: input.current.package.answers.map((answer) => ({ prompt: answer.prompt, text: answer.text })),
    variantId: input.variantId, profile: input.profile, channel: input.channel, lock: input.lock, automatic, standing: input.standing,
    mode: "start", drafter: input.drafterFactory(), reviewer: input.reviewerFactory(), answers: new Map(), earlier: new Map(),
    runId, atsKind: input.flow === "auto" ? input.classification.kind : "unknown", page
  };
  const walk = await walkSteppedForm(page, (step, form) => planSteppedStep(ctx, step, form), { runId });
  if (walk.outcome === "held") {
    await saveStopEvidenceQuietly({ database, dataDir: input.dataDir, run: { id: null, jobId }, page, stops: [heldStop(walk)] });
    throw stopError(automatic, `The application at ${hostOf(page.url())} continues over several pages; the agent filled it up to step ${walk.steps.at(-1) ?? 1}, but ${walk.hold}. Nothing was submitted. Finish this application in your own browser.`.slice(0, 1_000));
  }
  if (!walk.decisions.some((decision) => ACTED.has(decision.action))) {
    throw stopError(automatic, `No application form was reached at ${page.url()}: the several-page form showed no question the agent can fill or ask you about. Start the run yourself from the form's address.`);
  }
  const { status, decisions, pauses } = steppedOutcome(walk, []);
  logStandingAcceptances(database, jobId, decisions);
  setJobStatus(database, jobId, null, "APPLYING", posting.status === "APPLYING"
    ? "Browser run restarted after the previous run failed or was cancelled."
    : automatic
      ? "Browser run started automatically from the verified package; your approval is required before submission."
      : "Browser run started from the approved package.");
  const now = new Date().toISOString();
  const { kind } = input.classification;
  const run = saveBrowserRun(database, {
    id: runId,
    jobId,
    applicationUrl: input.formUrl,
    status,
    packageId: input.current.package.id,
    variantId: input.variantId,
    baseResumeId: uploadedBaseResumeId(decisions),
    applicationProfile: input.profile,
    atsKind: input.flow === "auto" ? kind : "unknown",
    atsConfidence: input.classification.confidence,
    suggestedAtsKind: input.flow === "auto" ? null : kind === "unknown" ? null : kind,
    atsConfirmed: input.flow === "auto",
    decisions: decisions.map(boundDecisionText),
    pauses: pauses.map(boundPauseQuestion),
    submittedAnswers: null,
    confirmationText: null,
    submissionApprovedAt: null,
    createdAt: now,
    updatedAt: now
  });
  if (walk.last) {
    await saveStopEvidenceQuietly({
      database, dataDir: input.dataDir, run: { id: runId, jobId }, page, stops: fillStops(walk.last.form, walk.last.unfilled, walk.last.pauses, true)
    });
  }
  if (status === "awaiting-approval") runTraceOf(page)?.endedCleanly();
  return { run, form: walk.last?.form ?? { url: page.url(), title: await page.title(), fields: [] }, applied: countApplied(decisions) };
}

/** The run's posting, package answers, and profile, for walking it again. */
function runInputs(database: DatabaseSync, run: BrowserRun) {
  const posting = getJobPosting(database, run.jobId);
  const current = getCurrentPackage(database, run.jobId);
  if (!posting || !current) throw new Error("The posting or its package is missing.");
  const packageAnswers = current.package.id === run.packageId ? current.package.answers.map(({ prompt, text }) => ({ prompt, text })) : [];
  const profile: ApplicationProfile = run.applicationProfile === "transcript" ? "transcript" : "default";
  const channel: ApplicationChannel | null = profile === "transcript" ? "handshake_internal" : null;
  return { posting, packageAnswers, profile, channel };
}

export async function continueSteppedRun(
  database: DatabaseSync,
  deps: SteppedRunDeps,
  run: BrowserRun,
  options: {
    openPage: (url: string) => Promise<BrowserPage>;
    dataDir: string;
    standing: StandingConsentSettings;
    drafterFactory: () => VoiceDrafter | null;
    reviewerFactory: () => PauseReviewer | null;
  }
): Promise<RunReport> {
  const { posting, packageAnswers, profile, channel } = runInputs(database, run);
  const opened = await options.openPage(run.applicationUrl);
  try {
    if (!hasSteppedWalk(opened)) throw new Error("A several-page run needs the application page adapter.");
    const page = opened;
    await steppedPrelude(page);
    const ctx: SteppedContext = {
      database, deps, jobId: run.jobId, candidateId: LOCAL_CANDIDATE_ID, posting, packageAnswers, variantId: run.variantId, profile, channel, lock: null,
      automatic: false, standing: options.standing, mode: "continue", drafter: options.drafterFactory(), reviewer: options.reviewerFactory(),
      answers: answeredPauses(run.pauses), earlier: new Map(run.decisions.map((decision) => [decision.fieldId, decision])),
      runId: run.id, atsKind: run.atsKind, page
    };
    const walk = await walkSteppedForm(page, (step, form) => planSteppedStep(ctx, step, form), { runId: run.id });
    // Nothing filled and nothing left to ask: the reopened page is not the run's form, so the run stays paused.
    if (walk.outcome !== "held" && !walk.decisions.some((decision) => ACTED.has(decision.action))) {
      throw new Error(`No application form was reached at ${page.url()}: the several-page form showed no question the agent can fill or ask you about. Start the run yourself from the form's address.`);
    }
    const outcome = steppedOutcome(walk, run.pauses);
    const updated = updateBrowserRun(database, run.id, {
      decisions: outcome.decisions.map(boundDecisionText),
      pauses: outcome.pauses.map(boundPauseQuestion),
      status: outcome.status,
      baseResumeId: uploadedBaseResumeId(outcome.decisions)
    });
    logStandingAcceptances(database, run.jobId, outcome.decisions, run.decisions);
    const target = { id: run.id, jobId: run.jobId };
    if (walk.outcome === "held") await saveStopEvidenceQuietly({ database, dataDir: options.dataDir, run: target, page, stops: [heldStop(walk)] });
    if (walk.last) {
      await saveStopEvidenceQuietly({
        database, dataDir: options.dataDir, run: target, page, stops: fillStops(walk.last.form, walk.last.unfilled, walk.last.pauses, true)
      });
    }
    if (updated.status === "awaiting-approval") runTraceOf(page)?.endedCleanly();
    return { run: updated, form: walk.last?.form ?? { url: page.url(), title: await page.title(), fields: [] }, applied: countApplied(outcome.decisions) };
  } finally {
    await opened.close();
  }
}

/**
 * Approved answers the submit walk would change: each value the run filled on a step the walk visited that the walk
 * no longer decides, or decides with another value. Pure.
 */
function approvedAnswersChanged(approved: FillDecision[], walked: FillDecision[], visited: ReadonlySet<number>): number {
  const now = new Map(walked.map((decision) => [decision.fieldId, decision]));
  let changed = 0;
  for (const decision of approved) {
    if (!VALUE_ACTIONS.has(decision.action) || decision.value === null) continue;
    const parsed = parseSteppedFieldId(decision.fieldId);
    if (!parsed || !visited.has(parsed.step)) continue;
    const walkedDecision = now.get(decision.fieldId);
    if (!walkedDecision || (VALUE_ACTIONS.has(walkedDecision.action) && walkedDecision.value !== decision.value)) changed += 1;
  }
  return changed;
}

/** This step's records replaced by `raw` (ids as the page has them), prefixed. */
function replaceStepRecords(
  base: { decisions: FillDecision[]; pauses: PauseRecord[] },
  step: number,
  raw: { decisions: FillDecision[]; pauses: PauseRecord[] }
): { decisions: FillDecision[]; pauses: PauseRecord[] } {
  const prefix = `step-${step}::`;
  return {
    decisions: [
      ...base.decisions.filter((decision) => !decision.fieldId.startsWith(prefix)),
      ...raw.decisions.map((decision) => ({ ...decision, fieldId: steppedFieldId(step, decision.fieldId) }))
    ],
    pauses: [
      ...base.pauses.filter((pause) => !pause.fieldId.startsWith(prefix)),
      ...raw.pauses.map((pause) => ({ ...pause, fieldId: steppedFieldId(step, pause.fieldId) }))
    ]
  };
}

export async function submitSteppedRun(
  database: DatabaseSync,
  deps: SteppedRunDeps,
  run: BrowserRun,
  options: {
    openPage: (url: string) => Promise<BrowserPage>;
    dataDir: string;
    standing: StandingConsentSettings;
    submitWait?: { timeoutMs?: number; pollMs?: number };
    policyApproval?: boolean;
  }
): Promise<BrowserRun> {
  if (options.policyApproval) {
    // Defensive: autoSubmitBlockers already refuses these runs.
    updateBrowserRun(database, run.id, { submissionApprovedAt: null });
    throw new Error("The auto-submit policy does not submit several-page forms on sites the agent has no adapter for; nothing was opened or clicked, and the run waits for your approval.");
  }
  const { posting, packageAnswers, profile, channel } = runInputs(database, run);
  const opened = await options.openPage(run.applicationUrl);
  const hold = (base: { decisions: FillDecision[]; pauses: PauseRecord[] }, held: { decision: FillDecision; pause: PauseRecord }): void => {
    updateBrowserRun(database, run.id, {
      status: "paused-needs-input",
      submissionApprovedAt: null,
      decisions: [...base.decisions.filter((decision) => decision.fieldId !== held.decision.fieldId), held.decision].map(boundDecisionText),
      pauses: [...base.pauses.filter((pause) => pause.fieldId !== held.pause.fieldId), held.pause].map(boundPauseQuestion)
    });
  };
  let page: SteppedPage;
  try {
    if (!hasSteppedWalk(opened)) throw new Error("A several-page run needs the application page adapter.");
    page = opened;
    await steppedPrelude(page);
    const challenge = page.visibleChallenge ? await page.visibleChallenge() : null;
    if (challenge) {
      hold(run, challengePause(challenge));
      throw new SubmissionChallenged(`Before the submit click the site showed ${challenge.detail}. The agent never solves CAPTCHAs, so this application is held for you: finish it in your own browser. The run is not marked submitted.`);
    }
  } catch (error) {
    await opened.close();
    throw error;
  }
  updateBrowserRun(database, run.id, { status: "submitting" });
  let heldForInput = false;
  let postSubmit: PostSubmitEvidence | null = null;
  let submitted: BrowserRun | null = null;
  let labels: Record<string, string> = {};
  try {
    const ctx: SteppedContext = {
      database, deps, jobId: run.jobId, candidateId: LOCAL_CANDIDATE_ID, posting, packageAnswers, variantId: run.variantId, profile, channel, lock: null,
      automatic: false, standing: options.standing, mode: "submit", drafter: null, reviewer: null,
      answers: answeredPauses(run.pauses), earlier: new Map(run.decisions.map((decision) => [decision.fieldId, decision])),
      runId: run.id, atsKind: run.atsKind, page
    };
    const walk = await walkSteppedForm(page, (step, form) => planSteppedStep(ctx, step, form), { runId: run.id });
    let outcome = steppedOutcome(walk, run.pauses);
    if (walk.outcome !== "last-page" || outcome.pauses.some((pause) => pause.status === "open")) {
      updateBrowserRun(database, run.id, {
        status: "paused-needs-input", submissionApprovedAt: null,
        decisions: outcome.decisions.map(boundDecisionText), pauses: outcome.pauses.map(boundPauseQuestion)
      });
      heldForInput = true;
      throw new SubmissionHeld(walk.outcome === "held"
        ? `The application stopped at step ${walk.steps.at(-1) ?? 1} before its last step: ${walk.hold}. Nothing was submitted; finish it in your own browser.`.slice(0, 1_000)
        : "The application asked for more before its last step. Answer the new questions, continue the run, and approve again.");
    }
    // Every answer the approval covered must still be what the walk filled on the steps it visited.
    const changed = approvedAnswersChanged(run.decisions, walk.decisions, new Set(walk.steps));
    if (changed > 0) {
      const held = formChangedPause(changed);
      hold(outcome, held);
      heldForInput = true;
      throw new SubmissionHeld(held.pause.question);
    }
    const last = walk.last!;
    // Read back before the click: every choice on a radio question must show as made (Track 25).
    const notTaken = await choicesNotTaken(page, last.form, last.decisions);
    if (notTaken.length > 0) {
      let raw = { decisions: last.decisions, pauses: last.pauses };
      for (const entry of notTaken) {
        const field = last.form.fields.find((candidate) => candidate.id === entry.fieldId);
        if (!field) continue;
        const held = unfilledPause(field, entry.reason, run.id);
        raw = {
          decisions: raw.decisions.map((decision) => (decision.fieldId === entry.fieldId ? held.decision : decision)),
          pauses: [...raw.pauses.filter((pause) => pause.fieldId !== entry.fieldId), held.pause]
        };
      }
      outcome = { ...outcome, ...replaceStepRecords(outcome, last.step, raw) };
      updateBrowserRun(database, run.id, {
        status: "paused-needs-input", submissionApprovedAt: null,
        decisions: outcome.decisions.map(boundDecisionText), pauses: outcome.pauses.map(boundPauseQuestion)
      });
      heldForInput = true;
      const names = new Map(last.form.fields.map((field) => [field.id, field.label]));
      const shown = notTaken.map((entry) => `"${names.get(entry.fieldId) ?? entry.fieldId}"`).join(", ");
      throw new SubmissionHeld(`Before the submit click ${shown} did not take the choice, so nothing was clicked; the application is held for you.`.slice(0, 600));
    }
    // A widget drawn while the form filled is read again right before the click.
    const lateChallenge = page.visibleChallenge ? await page.visibleChallenge() : null;
    if (lateChallenge) {
      hold(outcome, challengePause(lateChallenge));
      heldForInput = true;
      throw new SubmissionChallenged(`Before the submit click the site showed ${lateChallenge.detail}. The agent never solves CAPTCHAs, so this application is held for you: finish it in your own browser. The run is not marked submitted.`);
    }
    // The click goes only to the form's own submit control, on its last step (Track 38).
    const submitShown = page.submitControlShown ? await page.submitControlShown().catch(() => false) : null;
    const target = submitTargetHoldReason({ url: page.url(), submitShown, stepButtons: await page.stepButtons() });
    if (target) {
      const held = submitTargetPause(target);
      hold(outcome, held);
      heldForInput = true;
      throw new SubmissionHeld(held.pause.question);
    }
    let confirmation: string;
    try {
      confirmation = await submitAndConfirm(page, { ...options.submitWait, securityCode: null, atsKind: run.atsKind });
    } catch (error) {
      // Anything after the click (even a failed click) keeps what the page showed.
      postSubmit = postSubmitEvidenceOf(error) ?? await capturePostSubmitEvidence(page, "unknown");
      if (error instanceof SubmissionNeedsInput) {
        // The site refused the last step with field errors, so nothing was sent: the approval is withdrawn.
        const refused = invalidFieldPauses(last.form, last.decisions, last.pauses, error.invalidFields);
        const held = replaceStepRecords(outcome, last.step, refused);
        updateBrowserRun(database, run.id, {
          status: "paused-needs-input", submissionApprovedAt: null,
          decisions: held.decisions.map(boundDecisionText), pauses: held.pauses.map(boundPauseQuestion)
        });
        heldForInput = true;
      }
      throw error;
    }
    const submittedAnswers: Record<string, string> = {};
    for (const decision of walk.decisions) {
      if (VALUE_ACTIONS.has(decision.action) && decision.value !== null) submittedAnswers[decision.fieldId] = decision.value;
    }
    submitted = updateBrowserRun(database, run.id, { status: "submitted", submittedAnswers, confirmationText: confirmation });
    setJobStatus(database, run.jobId, null, "SUBMITTED", `Submitted with confirmation: ${confirmation.slice(0, 200)}`);
    runTraceOf(page)?.endedCleanly();
    labels = walk.fieldLabels;
  } catch (error) {
    if (!heldForInput) updateBrowserRun(database, run.id, { status: "failed" });
    // Kept local (mode 600) and never sent anywhere; saving it never changes the outcome.
    if (postSubmit) await savePostSubmitEvidenceQuietly({ database, dataDir: options.dataDir, run, page, evidence: postSubmit });
    throw error;
  } finally {
    await page.close();
  }
  if (!submitted) throw new Error("The submission finished without a result.");
  await deps.recordSubmission(run.jobId, labels);
  return submitted;
}
