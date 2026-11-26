import type { DatabaseSync } from "node:sqlite";

import {
  closeProfileDatabase,
  findBrowserRunIds,
  findCurrentQuestionAnswerIds,
  findQuestionAliasIds,
  getBrowserRun,
  getCurrentFacts,
  getJobPosting,
  getProfileDatabase,
  listCurrentQuestionAnswers,
  listQuestionAliases,
  LOCAL_CANDIDATE_ID,
  openApplicationAuditDatabase,
  resolveProfileDataDirectory,
  revokeQuestionAlias,
  revokeQuestionAnswer
} from "@internship-agent/db";
import {
  autoSubmitSettings,
  candidateFactKeySchema,
  factDefinitions,
  formatFactValue,
  manualOnly,
  notSavedReasonText,
  scopeKey,
  workspaceProfileSchema,
  type BrowserRun,
  type PauseRecord,
  type QuestionAlias,
  type QuestionAliasSource,
  type WorkspaceProfile
} from "@internship-agent/domain";
import { ZodError } from "zod";

import { classifyOpenPauses } from "./application-holds";
import { targetTerm } from "./application-target";
import { ATTACHED_RESUME_FIELD, answerRunPause, continueBrowserRun, pauseContext, recheckPausedRuns, type RecheckRunResult, type RunReport } from "./browser-orchestrator";
import { continuedRunNote } from "./continued-auto-submit";
import { readDigestState } from "./daily-digest";
import { redactNoticeText } from "./pass-notice";
import { acquirePipelineLock } from "./pipeline-lock";
import { SAVED_MATCH_KINDS, type SavedMatchKind } from "./pause-recheck";
import { planPauseMemory } from "./question-answers";
import { postingQuestionContext } from "./saved-answers";

/**
 * `pnpm run:questions`, `pnpm run:answer`, and `pnpm profile:answers`: answer
 * a held run's questions from the command line (the internship Discord
 * session runs these for the candidate). Questions use the Discord notice's
 * `Q<n>` numbers (`pauses[n-1]`). Answers are never printed. Fully
 * deterministic: continuing passes no voice drafter and no pause reviewer, so
 * no model is called. An AI review suggestion already on a pause is shown and
 * may be used as the answer with `--use-draft`.
 * `--digest <n>` names a run by the last daily digest's item number instead
 * of `--run` (mapped through the digest state file); `Q<n>` stays the same.
 */

export type RunCommandDeps = {
  open(profile: WorkspaceProfile): DatabaseSync;
  close(profile: WorkspaceProfile): void;
  dataDir(profile: WorkspaceProfile): string;
  log(line: string): void;
  acquireLock(dataDir: string): () => void;
  continueRun(runId: string, options: { database: DatabaseSync; dataDir: string; voiceDrafter: null; pauseReviewer: null }): Promise<RunReport>;
};

export type ProfileAnswersDeps = Pick<RunCommandDeps, "open" | "close" | "log">;

const QUESTIONS_USAGE = "Usage: pnpm run:questions (--run <id or 8-character prefix> | --digest <n>) [--profile real|demo]";
const ANSWER_USAGE = "Usage: pnpm run:answer (--run <id or 8-character prefix> | --digest <n>) --q <n> (--answer \"<text or option>\" | --use-draft) [--once] [--continue] [--profile real|demo]";
const PROFILE_ANSWERS_USAGE = "Usage: pnpm profile:answers [--profile real|demo] [--revoke <id or 8-character prefix> | --revoke-alias <id or 8-character prefix>]";
const QUESTIONS_RECHECK_USAGE = "Usage: pnpm questions:recheck [--profile real|demo] [--apply]";
const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runDeps(deps: Partial<RunCommandDeps>): RunCommandDeps {
  return {
    open: deps.open ?? getProfileDatabase,
    close: deps.close ?? closeProfileDatabase,
    dataDir: deps.dataDir ?? resolveProfileDataDirectory,
    log: deps.log ?? ((line) => console.log(line)),
    acquireLock: deps.acquireLock ?? ((dataDir) => acquirePipelineLock(dataDir)),
    continueRun: deps.continueRun ?? ((runId, options) => continueBrowserRun(runId, options))
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function labelOf(pause: Pick<PauseRecord, "label">): string {
  return clip(redactNoticeText(pause.label), 200);
}

function ref(id: string): string {
  return id.slice(0, 8);
}

function errorText(error: unknown): string {
  return clip(redactNoticeText(error instanceof Error ? error.message : String(error)), 300);
}

/** One question line, exactly as the Discord notice's questionLines writes it (without the indent). */
function questionLine(pause: PauseRecord, n: number, correction: boolean): string {
  const label = labelOf(pause);
  if (pause.fieldId === "site-security-code") return `Q${n} agent review: "${label}"`;
  if (correction) return `Q${n} fix this field in the browser: "${label}"`;
  if (pause.safeguard) return `Q${n} CAPTCHA or safeguard, solve it in the browser: "${label}"`;
  if (pause.upload) return `Q${n} needs a document: "${label}"`;
  if (pause.sensitive) return `Q${n} demographic, answered for this application only: "${label}"`;
  return `Q${n}: "${label}"`;
}

function openNumbers(run: BrowserRun): number[] {
  return run.pauses.flatMap((pause, index) => (pause.status === "open" ? [index + 1] : []));
}

function stillOpenLine(run: BrowserRun): string {
  const open = openNumbers(run);
  return open.length > 0 ? `Still open: ${open.map((n) => `Q${n}`).join(", ")}` : "No open questions remain.";
}

function resolveRun(database: DatabaseSync, typed: string): BrowserRun {
  const runRef = clip(typed, 40);
  if (FULL_ID.test(typed)) {
    const run = getBrowserRun(database, typed.toLowerCase());
    if (!run) throw new Error(`No browser run matches "${runRef}".`);
    return run;
  }
  const ids = findBrowserRunIds(database, typed);
  if (ids.length === 0) throw new Error(`No browser run matches "${runRef}".`);
  if (ids.length > 1) throw new Error(`Several runs match "${runRef}"; give more characters.`);
  const run = getBrowserRun(database, ids[0]!);
  if (!run) throw new Error(`No browser run matches "${runRef}".`);
  return run;
}

/** The run behind the last daily digest's item `n` (the digest state file maps numbers to runs). */
function resolveDigestRun(database: DatabaseSync, dataDir: string, n: number): BrowserRun {
  const item = readDigestState(dataDir).items.find((entry) => entry.number === n);
  if (!item) throw new Error(`Digest item ${n} is not in the last digest.`);
  const run = getBrowserRun(database, item.runId);
  if (!run) throw new Error(`Digest item ${n}'s run no longer exists.`);
  return run;
}

/** Exactly one of `--run <ref>` / `--digest <n>`; null when neither, both, or a digest number that is not a positive integer. */
function runTarget(values: Map<string, string>): { run: string } | { digest: number } | null {
  const runRef = values.get("--run")?.trim();
  const digestText = values.get("--digest");
  if (values.has("--run") && digestText !== undefined) return null;
  if (digestText !== undefined) {
    if (!/^\d+$/.test(digestText)) return null;
    const n = Number(digestText);
    return n >= 1 && Number.isSafeInteger(n) ? { digest: n } : null;
  }
  return runRef ? { run: runRef } : null;
}

/** Reads `--flag value` pairs and bare switches; null on anything unknown or missing. */
function parseFlags(
  argv: string[],
  valued: readonly string[],
  switches: readonly string[]
): { values: Map<string, string>; set: Set<string> } | null {
  const values = new Map<string, string>();
  const set = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (switches.includes(arg)) {
      if (set.has(arg)) return null;
      set.add(arg);
    } else if (valued.includes(arg)) {
      const value = argv[index + 1];
      if (value === undefined || values.has(arg)) return null;
      values.set(arg, value);
      index += 1;
    } else {
      return null;
    }
  }
  return { values, set };
}

function parseProfile(value: string | undefined): WorkspaceProfile | null {
  if (value === undefined) return "real";
  const parsed = workspaceProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function runQuestionsCommand(argv: string[], deps: Partial<RunCommandDeps> = {}): Promise<number> {
  const io = runDeps(deps);
  const flags = parseFlags(argv, ["--run", "--digest", "--profile"], []);
  const profile = parseProfile(flags?.values.get("--profile"));
  const target = flags ? runTarget(flags.values) : null;
  if (!flags || !profile || !target) {
    io.log(QUESTIONS_USAGE);
    return 2;
  }
  const database = io.open(profile);
  try {
    let run: BrowserRun;
    try {
      run = "digest" in target ? resolveDigestRun(database, io.dataDir(profile), target.digest) : resolveRun(database, target.run);
    } catch (error) {
      // Only the reference the caller typed; a long hex prefix is not candidate data.
      io.log(error instanceof Error ? error.message : String(error));
      return 1;
    }
    const posting = getJobPosting(database, run.jobId);
    const name = posting ? `${clip(posting.companyName, 120)} — ${clip(posting.title, 120)}` : "Unknown posting";
    io.log(`Run ${ref(run.id)}: ${name} (${run.status})`);
    if ("digest" in target) {
      // The digest shows a run's asks in this order (up to two), so a reply like "1: yes, May 15" maps onto these Q numbers.
      const asks = classifyOpenPauses(run.pauses).filter(({ kind }) => kind === "question").map(({ index }) => `Q${index + 1}`);
      io.log(`Digest item ${target.digest} (asks in this order: ${asks.length > 0 ? asks.join(", ") : "none"})`);
    }
    let count = 0;
    for (const { index, pause, kind: routing } of classifyOpenPauses(run.pauses)) {
      count += 1;
      const kind = pause.fieldKind ?? "unknown kind";
      let options = "";
      if (pause.options?.length) {
        const shown = pause.options.slice(0, 25).map((option) => clip(option, 60)).join(" | ");
        const more = pause.options.length - 25;
        options = `: ${shown}${more > 0 ? ` (+${more} more)` : ""}`;
      }
      let hint: string;
      if (pause.fieldId === ATTACHED_RESUME_FIELD) hint = "answer yes to keep it";
      else if (pause.fieldId === "site-security-code") hint = "no candidate answer requested";
      else if (routing === "correction") hint = "cannot be answered here; fix the field in the browser";
      else if (pause.safeguard) hint = "cannot be answered here; solve it in the browser";
      else if (pause.upload) hint = "cannot be answered here; attach it in the browser";
      else {
        const plan = await planPauseMemory(pause, {
          companyName: posting?.companyName ?? null,
          context: { ...postingQuestionContext(posting), ...(pauseContext(pause.suggestedScope) ?? {}) }
        });
        if (plan.path === "fact") hint = `would be saved as ${factDefinitions[plan.key].label.toLocaleLowerCase("en-US")}`;
        else if (plan.path === "question") hint = "would be saved for reuse";
        else hint = `this run only (${notSavedReasonText(plan.reason)})`;
      }
      io.log(`${questionLine(pause, index + 1, routing === "correction")} — ${kind}${options} — ${hint}`);
      if (pause.draft?.source === "pause_review" && pause.draft.text.trim()) {
        io.log(`   AI suggestion, not sent: "${clip(redactNoticeText(pause.draft.text.replace(/\s+/g, " ").trim()), 300)}"`);
      }
    }
    if (count > 0) {
      io.log(`${count} open question(s).`);
      const named = "digest" in target ? `--digest ${target.digest}` : `--run ${ref(run.id)}`;
      io.log(`Answer with: pnpm run:answer ${named} --q <n> --answer "<text or option>"`);
    } else {
      io.log("No open questions.");
    }
    return 0;
  } finally {
    io.close(profile);
  }
}

export async function runAnswerCommand(argv: string[], deps: Partial<RunCommandDeps> = {}): Promise<number> {
  const io = runDeps(deps);
  const flags = parseFlags(argv, ["--run", "--digest", "--q", "--answer", "--profile"], ["--once", "--continue", "--use-draft"]);
  const profile = parseProfile(flags?.values.get("--profile"));
  const target = flags ? runTarget(flags.values) : null;
  const qText = flags?.values.get("--q");
  const answer = flags?.values.get("--answer");
  const q = qText !== undefined && /^\d+$/.test(qText) ? Number(qText) : null;
  const once = flags?.set.has("--once") ?? false;
  const proceed = flags?.set.has("--continue") ?? false;
  const useDraft = flags?.set.has("--use-draft") ?? false;
  const answering = qText !== undefined || answer !== undefined || useDraft;
  const valid = flags && profile && target
    && (answering
      ? q !== null && q >= 1 && (useDraft ? answer === undefined : answer !== undefined && answer.trim() !== "")
      : proceed && !once);
  if (!valid) {
    io.log(ANSWER_USAGE);
    return 2;
  }
  if (manualOnly()) {
    io.log("Not run: manual checklist mode is on; browser runs are off.");
    return 1;
  }
  const dataDir = io.dataDir(profile);
  let release: () => void;
  try {
    release = io.acquireLock(dataDir);
  } catch (error) {
    io.log(`Not run: ${errorText(error)}`);
    return 1;
  }
  try {
    const database = io.open(profile);
    let run: BrowserRun;
    try {
      run = "digest" in target ? resolveDigestRun(database, dataDir, target.digest) : resolveRun(database, target.run);
    } catch (error) {
      // Only the reference the caller typed; a long hex prefix is not candidate data.
      io.log(error instanceof Error ? error.message : String(error));
      return 1;
    }
    if (run.status !== "paused-needs-input") {
      io.log(`Run ${ref(run.id)} is ${run.status}; only paused runs take answers.`);
      return 1;
    }
    if (answering && q !== null) {
      const pause = run.pauses[q - 1];
      if (!pause) {
        io.log(`Q${q} does not exist; run ${ref(run.id)} has ${run.pauses.length} question(s).`);
        return 1;
      }
      // --use-draft answers with the AI review's suggestion shown by pnpm run:questions (an essay: never saved for reuse).
      const suggestion = pause.draft?.source === "pause_review" ? pause.draft.text.trim() : "";
      if (useDraft && !suggestion) {
        io.log(`Q${q} has no AI suggestion; answer it with --answer.`);
        return 1;
      }
      const given = useDraft ? suggestion : answer ?? "";
      let result: Awaited<ReturnType<typeof answerRunPause>>;
      try {
        result = await answerRunPause(run.id, pause.fieldId, given, !once, { database });
      } catch (error) {
        io.log(error instanceof ZodError
          ? "Not answered: that answer is not valid for this question."
          : `Not answered: ${errorText(error)}`);
        return 1;
      }
      const label = labelOf(pause);
      const { outcome } = result;
      if (outcome.saved && outcome.store === "question") {
        const note = outcome.status === "unchanged" ? " (unchanged)" : outcome.status === "replaced" ? " (replaces the earlier answer)" : "";
        io.log(`Q${q} saved for reuse${note}: "${label}"`);
      } else if (outcome.saved) {
        io.log(`Q${q} saved for reuse as ${factDefinitions[outcome.factKey].label.toLocaleLowerCase("en-US")}: "${label}"`);
      } else {
        io.log(`Q${q} used once (${outcome.detail.replace(/[.\s]+$/, "")}): "${label}"`);
      }
      if (result.rechecked > 0) {
        io.log(`Also answered ${result.rechecked} question(s) in held runs from your saved answers (pnpm run:questions shows what is left).`);
      }
      run = result.run;
      io.log(stillOpenLine(run));
    }
    if (proceed || openNumbers(run).length === 0) {
      let report: RunReport;
      try {
        report = await io.continueRun(run.id, { database, dataDir, voiceDrafter: null, pauseReviewer: null });
      } catch (error) {
        io.log(`The run did not continue: ${errorText(error)}`);
        return 1;
      }
      io.log(`Run ${ref(run.id)} continued: ${report.run.status}.`);
      if (report.run.status === "awaiting-approval") {
        io.log(continuedRunNote(database, dataDir, report.run, autoSubmitSettings(process.env) !== null && targetTerm() !== null));
      } else if (report.run.status === "paused-needs-input") {
        io.log(stillOpenLine(report.run));
      }
    } else {
      io.log("Not continued: answer the open questions, or add --continue to refill the form now.");
    }
    return 0;
  } finally {
    io.close(profile);
    release();
  }
}

const ALIAS_SOURCE_TEXT: Record<QuestionAliasSource, string> = {
  candidate_answer: "your answer",
  saved_answer_match: "matched at a stop",
  ai_review: "AI review"
};

/** One recorded wording under its saved answer; never an answer value. */
function aliasLine(alias: QuestionAlias): string {
  const options = alias.options.length > 0 ? `${alias.options.length} options` : "no options";
  return `    wording "${clip(alias.wording, 120)}" (${alias.atsKind}, ${options}, ${ALIAS_SOURCE_TEXT[alias.source]}, seen ${alias.seenCount}x, last ${alias.lastSeenAt.slice(0, 10)}) [alias ${ref(alias.id)}]`;
}

/** A saved fact's value as profile:answers shows it: "saved" for a protected self-identification answer, "not saved now" when none is current. */
function factValueText(key: string, scope: string, facts: ReturnType<typeof getCurrentFacts>): string {
  const parsed = candidateFactKeySchema.safeParse(key);
  if (!parsed.success) return "not saved now";
  const fact = facts.find((entry) => entry.key === parsed.data && scopeKey(entry.scope) === scope);
  if (!fact) return "not saved now";
  if (factDefinitions[parsed.data].sensitivity === "protected") return "saved";
  return clip(formatFactValue(fact.value), 120);
}

export async function runProfileAnswersCommand(argv: string[], deps: Partial<ProfileAnswersDeps> = {}): Promise<number> {
  const io = {
    open: deps.open ?? getProfileDatabase,
    close: deps.close ?? closeProfileDatabase,
    log: deps.log ?? ((line: string) => console.log(line))
  };
  const flags = parseFlags(argv, ["--profile", "--revoke", "--revoke-alias"], []);
  const profile = parseProfile(flags?.values.get("--profile"));
  const revoke = flags?.values.get("--revoke")?.trim();
  const revokeAlias = flags?.values.get("--revoke-alias")?.trim();
  if (!flags || !profile || revoke === "" || revokeAlias === "" || (revoke !== undefined && revokeAlias !== undefined)) {
    io.log(PROFILE_ANSWERS_USAGE);
    return 2;
  }
  const database = io.open(profile);
  try {
    if (revokeAlias !== undefined) {
      const ids = findQuestionAliasIds(database, LOCAL_CANDIDATE_ID, revokeAlias);
      if (ids.length === 0) {
        io.log(`Not found: ${clip(revokeAlias, 40)}`);
        return 1;
      }
      if (ids.length > 1) {
        io.log(`Several recorded wordings match "${clip(revokeAlias, 40)}"; give more characters.`);
        return 1;
      }
      const id = ids[0]!;
      const wording = listQuestionAliases(database, LOCAL_CANDIDATE_ID).find((alias) => alias.id === id)?.wording ?? "";
      if (!revokeQuestionAlias(database, LOCAL_CANDIDATE_ID, id)) {
        io.log(`Not found: ${clip(revokeAlias, 40)}`);
        return 1;
      }
      io.log(`revoked alias ${ref(id)} "${clip(wording, 120)}"`);
      return 0;
    }
    if (revoke === undefined) {
      const answers = listCurrentQuestionAnswers(database, LOCAL_CANDIDATE_ID);
      const aliases = listQuestionAliases(database, LOCAL_CANDIDATE_ID);
      if (answers.length === 0) io.log("No saved question answers.");
      for (const saved of answers) {
        io.log(`${ref(saved.id)} "${clip(saved.question, 120)}" -> ${clip(saved.answer, 120)} [${saved.answerKind}, saved ${saved.createdAt.slice(0, 10)}]`);
        for (const alias of aliases) {
          if (alias.target.kind === "question" && alias.target.questionKey === saved.questionKey) io.log(aliasLine(alias));
        }
      }
      const factAliases = aliases.filter((alias) => alias.target.kind === "fact");
      if (factAliases.length > 0) {
        io.log("Saved facts with recorded wordings:");
        const facts = getCurrentFacts(database, LOCAL_CANDIDATE_ID);
        const groups = new Map<string, QuestionAlias[]>();
        for (const alias of factAliases) {
          if (alias.target.kind !== "fact") continue;
          const group = `${alias.target.factKey}\u0000${alias.target.scopeKey}`;
          groups.set(group, [...(groups.get(group) ?? []), alias]);
        }
        for (const [group, members] of groups) {
          const [key = "", scope = ""] = group.split("\u0000");
          io.log(`fact ${key} [${scope}]: ${factValueText(key, scope, facts)}`);
          for (const alias of members) io.log(aliasLine(alias));
        }
      }
      return 0;
    }
    const ids = findCurrentQuestionAnswerIds(database, LOCAL_CANDIDATE_ID, revoke);
    if (ids.length === 0) {
      io.log(`Not found: ${clip(revoke, 40)}`);
      return 1;
    }
    if (ids.length > 1) {
      io.log(`Several saved answers match "${clip(revoke, 40)}"; give more characters.`);
      return 1;
    }
    const id = ids[0]!;
    const question = listCurrentQuestionAnswers(database, LOCAL_CANDIDATE_ID).find((saved) => saved.id === id)?.question ?? "";
    if (!revokeQuestionAnswer(database, LOCAL_CANDIDATE_ID, id)) {
      io.log(`Not found: ${clip(revoke, 40)}`);
      return 1;
    }
    io.log(`revoked ${ref(id)} "${clip(question, 120)}"`);
    return 0;
  } finally {
    io.close(profile);
  }
}

export type QuestionsRecheckDeps = {
  /** The dry run's handle: read-only, never migrated. */
  openReadOnly(profile: WorkspaceProfile): DatabaseSync;
  closeReadOnly(database: DatabaseSync): void;
  /** `--apply`'s handle (migrated). */
  open(profile: WorkspaceProfile): DatabaseSync;
  close(profile: WorkspaceProfile): void;
  dataDir(profile: WorkspaceProfile): string;
  acquireLock(dataDir: string): () => void;
  log(line: string): void;
};

/**
 * `pnpm questions:recheck [--profile real|demo] [--apply]`: re-checks every
 * held run's open questions against the saved answers (recheckPausedRuns).
 * The default dry run opens the database read-only and writes nothing;
 * `--apply` marks the matched questions answered under the pipeline lock.
 * Prints counts and question labels only, never an answer.
 */
export async function runQuestionsRecheckCommand(argv: string[], deps: Partial<QuestionsRecheckDeps> = {}): Promise<number> {
  const io: QuestionsRecheckDeps = {
    openReadOnly: deps.openReadOnly ?? openApplicationAuditDatabase,
    closeReadOnly: deps.closeReadOnly ?? ((database) => database.close()),
    open: deps.open ?? getProfileDatabase,
    close: deps.close ?? closeProfileDatabase,
    dataDir: deps.dataDir ?? resolveProfileDataDirectory,
    acquireLock: deps.acquireLock ?? ((dataDir) => acquirePipelineLock(dataDir)),
    log: deps.log ?? ((line) => console.log(line))
  };
  const flags = parseFlags(argv, ["--profile"], ["--apply"]);
  const profile = parseProfile(flags?.values.get("--profile"));
  if (!flags || !profile) {
    io.log(QUESTIONS_RECHECK_USAGE);
    return 2;
  }
  const apply = flags.set.has("--apply");
  if (!apply) {
    const database = io.openReadOnly(profile);
    try {
      printRecheck(io.log, database, await recheckPausedRuns(database, { apply: false }), false);
      return 0;
    } finally {
      io.closeReadOnly(database);
    }
  }
  if (manualOnly()) {
    io.log("Not run: manual checklist mode is on; browser runs are off.");
    return 1;
  }
  let release: () => void;
  try {
    release = io.acquireLock(io.dataDir(profile));
  } catch (error) {
    io.log(`Not run: ${errorText(error)}`);
    return 1;
  }
  try {
    const database = io.open(profile);
    printRecheck(io.log, database, await recheckPausedRuns(database, { apply: true }), true);
    return 0;
  } finally {
    io.close(profile);
    release();
  }
}

function printRecheck(log: (line: string) => void, database: DatabaseSync, results: RecheckRunResult[], applied: boolean): void {
  const kinds = new Map<SavedMatchKind, number>(SAVED_MATCH_KINDS.map((kind) => [kind, 0]));
  let matched = 0;
  let skipped = 0;
  let left = 0;
  let toReview = 0;
  let unread = 0;
  for (const result of results) {
    if (result.error) unread += 1;
    skipped += result.skipped;
    left += result.left.length;
    toReview += result.left.filter((entry) => entry.aiEligible).length;
    matched += result.matches.length;
    for (const match of result.matches) kinds.set(match.kind, (kinds.get(match.kind) ?? 0) + 1);
    if (result.matches.length === 0) continue;
    const run = getBrowserRun(database, result.runId);
    const posting = run ? getJobPosting(database, run.jobId) : null;
    const name = posting ? `${clip(posting.companyName, 120)} — ${clip(posting.title, 120)}` : "Unknown posting";
    log(`Run ${ref(result.runId)}: ${name}: ${result.matches.map((match) => `Q${match.index + 1} ${match.kind}`).join(", ")}`);
  }
  const perKind = SAVED_MATCH_KINDS.map((kind) => `${kind} ${kinds.get(kind) ?? 0}`).join(", ");
  const open = matched + skipped + left;
  log(`open pauses: ${open}; ${applied ? "answered" : "would be answered"} by saved answers: ${matched} (${perKind}); skipped (safeguard, upload, sensitive, page failures, faults, older runs): ${skipped}; still open: ${left}, of which would reach AI review: ${toReview}`);
  if (unread > 0) log(`${unread} held run(s) could not be read and were left as they are.`);
}
