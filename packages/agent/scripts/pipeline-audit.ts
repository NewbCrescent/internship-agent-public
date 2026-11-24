import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  acknowledgeApplicationHolds, applicationHoldDelivered, applicationHoldDeliveries, applicationHoldReceiptChecks, applicationHoldSchemaPresent,
  applicationHoldTrace, applicationReceiptConfirmed, findBrowserRunIds, findJobIds,
  getBrowserRun, getCurrentPackage, getJobPosting, getProfileDatabase, listApplicationAuditRuns, listApplicationEvents,
  listJobSummaries, openApplicationAuditDatabase, resolveProfileDataDirectory, type ApplicationAuditRun, type ApplicationHold
} from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";

import { acquireHoldDeliveryGuard, holdIdentity, refreshApplicationHolds } from "../src/application-holds";
import { readSubmitEvidence } from "../src/submit-evidence";

/**
 * pipeline:audit
 *
 * Inspects active application runs and pre-run Workday timeouts. Reports findings
 * and prompts the agent about new items that need attention.
 *
 * Usage:
 *   pnpm pipeline:audit [--profile real|demo] [--json] [--watch] [--interval 60]
 */
interface TriageItem {
  runId: string | null;
  jobId: string;
  company: string;
  title: string;
  ats: string;
  status: string;
  category: "ATS_BUG" | "UNCONFIRMED_SUBMISSION" | "RUN_NEEDS_REVIEW" | "MISSING_FACT" | "MANUAL_GATE" | "AWAITING_APPROVAL";
  summary: string;
  details: string[];
  suggestedAction: string;
}

const ACCOUNT_TIMEOUT = /^Automatic browser run waiting: Workday \S+: the account step stopped \(Workday did not answer the (?:create-account|sign-in) submit within \d+ seconds\b/;

function workdayAccountTimeouts(database: DatabaseSync, jobsWithRuns: ReadonlySet<string>): TriageItem[] {
  const findings: TriageItem[] = [];
  for (const job of listJobSummaries(database, { status: "READY_FOR_REVIEW" })) {
    if (jobsWithRuns.has(job.id)) continue;
    const event = listApplicationEvents(database, job.id).reverse().find(({ fromStatus, toStatus, detail }) =>
      fromStatus !== toStatus || detail?.startsWith("Automatic browser run ") || detail?.startsWith("Not pursued for your target: ")
    );
    if (!event?.detail || !ACCOUNT_TIMEOUT.test(event.detail)) continue;
    const current = getCurrentPackage(database, job.id);
    if (!current?.verification || current.verification.blocked) continue;
    findings.push({
      runId: null,
      jobId: job.id,
      company: job.companyName,
      title: job.title,
      ats: "workday",
      status: job.status,
      category: "ATS_BUG",
      summary: "Workday account step timed out before a browser run was saved.",
      details: [],
      suggestedAction: "Inspect the job timeline and diagnose the Workday account timeout."
    });
  }
  return findings;
}

function itemReference(item: TriageItem): string {
  return item.runId ? `Run ID: ${item.runId.slice(0, 8)}` : `Job ID: ${item.jobId.slice(0, 8)}`;
}

function categorizeRun(row: ApplicationAuditRun, dataDir: string): TriageItem {
  const allPauses = JSON.parse(row.pauses_json || "[]") as Array<{
    status?: string;
    label?: string;
    reason?: string;
    type?: string;
    safeguard?: boolean;
    sensitive?: boolean;
  }>;
  const openPauses = allPauses.filter((p) => p.status === "open");
  const openLabels = openPauses.map((p) => p.label || p.reason || p.type || "unknown").filter(Boolean);

  if (row.status === "awaiting-approval") {
    return {
      runId: row.id,
      jobId: row.job_id,
      company: row.company_name,
      title: row.title,
      ats: row.ats_kind,
      status: row.status,
      category: "AWAITING_APPROVAL",
      summary: `Form filled; awaiting human or policy approval.`,
      details: openLabels.length ? openLabels : allPauses.map((p) => p.label || p.reason || p.type).filter(Boolean) as string[],
      suggestedAction: `Review answered questions and approve submission if authorized.`
    };
  }

  if (row.status === "paused-needs-input" && openLabels.length > 0) {
    if (openPauses.some((p) => p.safeguard)) {
      return {
        runId: row.id,
        jobId: row.job_id,
        company: row.company_name,
        title: row.title,
        ats: row.ats_kind,
        status: row.status,
        category: "MANUAL_GATE",
        summary: `Blocked by CAPTCHA / bot safeguard challenge on ${row.ats_kind}: ${openLabels.join("; ")}`,
        details: openLabels,
        suggestedAction: `Complete challenge directly in browser at ${row.application_url}`
      };
    }

    return {
      runId: row.id,
      jobId: row.job_id,
      company: row.company_name,
      title: row.title,
      ats: row.ats_kind,
      status: row.status,
      category: "MISSING_FACT",
      summary: `Paused on unanswered candidate questions or missing facts: ${openLabels.join("; ")}`,
      details: openLabels,
      suggestedAction: "Ask the candidate for the missing answer."
    };
  }

  const evidence = row.status === "failed" ? readSubmitEvidence(dataDir, { id: row.id, jobId: row.job_id })[0] : undefined;
  if (evidence?.outcome === "unknown") {
    return {
      runId: row.id,
      jobId: row.job_id,
      company: row.company_name,
      title: row.title,
      ats: row.ats_kind,
      status: row.status,
      category: "UNCONFIRMED_SUBMISSION",
      summary: "The application reached submit, but the outcome could not be confirmed.",
      details: [],
      suggestedAction: "Confirm whether the employer received the application through its portal or a confirmation email."
    };
  }

  if (row.ats_kind === "workday" && (evidence?.detail?.includes("timeout") || openLabels.some((label) => label.includes("Workday did not answer")))) {
    return {
      runId: row.id,
      jobId: row.job_id,
      company: row.company_name,
      title: row.title,
      ats: row.ats_kind,
      status: row.status,
      category: "ATS_BUG",
      summary: "Workday automation timed out.",
      details: openLabels,
      suggestedAction: "Inspect the run evidence and diagnose the Workday timeout."
    };
  }

  return {
    runId: row.id,
    jobId: row.job_id,
    company: row.company_name,
    title: row.title,
    ats: row.ats_kind,
    status: row.status,
    category: "RUN_NEEDS_REVIEW",
    summary: evidence ? `Saved evidence indicates ${evidence.outcome}.` : `Browser run status: ${row.status}.`,
    details: openLabels,
    suggestedAction: "Inspect the run evidence and timeline to establish what happened."
  };
}

function findingLines(items: TriageItem[]): string[] {
  return items.flatMap((item) => [
    `  * ${item.company} (${item.title}) [ATS: ${item.ats}]`,
    `    Issue: ${item.summary}`,
    `    Action: ${item.suggestedAction} (${itemReference(item)})`
  ]);
}

function printAudit(profile: string, audit: ReturnType<typeof readPipelineAudit>, json: boolean): void {
  const { total, submitted, uncompleted, categories } = audit;
  if (json) {
    console.log(JSON.stringify({ total, submitted, uncompleted }, null, 2));
    return;
  }

  console.log("================================================================================");
  console.log("  INTERNSHIP AGENT: APPLICATION AUDIT & PARALLEL PIPELINE TRIAGE");
  console.log("================================================================================");
  console.log(`Workspace Profile: ${profile}`);
  console.log(`Total Active Runs: ${total} | Submitted: ${submitted} | Findings: ${uncompleted.length}\n`);

  console.log("================================================================================");
  console.log("  MANDATE: PARALLELISM & SUBAGENT HAND-OFF (DO NOT FORGET CONTEXT)");
  console.log("================================================================================");
  console.log("1. PARALLELISM: Group independent ATS bugs and issues below and dispatch them");
  console.log("   concurrently to separate subagents in isolated git worktrees (/tmp/worktree-*).");
  console.log("2. SUBAGENT HAND-OFF: Follow the manager-worker pipeline rigorously:");
  console.log("   Implementer -> Fresh Independent Rechecker -> Commit Checkpoint -> Merge.");
  console.log("3. FACT INTEGRITY: Never invent candidate facts. Only prompt user for missing facts.");
  console.log("================================================================================\n");

  console.log(`[1] CODE & ATS BUGS (${categories.ATS_BUG.length} items - DELEGATE TO PARALLEL WORKERS):`);
  if (categories.ATS_BUG.length === 0) {
    console.log("  None.");
  } else {
    console.log(findingLines(categories.ATS_BUG).join("\n"));
  }
  console.log("");

  for (const [heading, items] of [
    ["UNCONFIRMED SUBMISSIONS", categories.UNCONFIRMED_SUBMISSION],
    ["RUNS NEEDING EVIDENCE REVIEW", categories.RUN_NEEDS_REVIEW]
  ] as const) {
    console.log(`${heading} (${items.length} items):`);
    console.log(items.length > 0 ? findingLines(items).join("\n") : "  None.");
    console.log("");
  }

  console.log(`[2] MISSING CANDIDATE FACTS (${categories.MISSING_FACT.length} items - PROMPT USER ONCE):`);
  if (categories.MISSING_FACT.length === 0) {
    console.log("  None. All questions answered.");
  } else {
    for (const item of categories.MISSING_FACT) {
      console.log(`  * ${item.company} - ${item.title}`);
      console.log(`    Missing: ${item.summary}`);
      console.log(`    Action: ${item.suggestedAction}`);
    }
  }
  console.log("");

  console.log(`[3] AWAITING APPROVAL (${categories.AWAITING_APPROVAL.length} items):`);
  for (const item of categories.AWAITING_APPROVAL) {
    console.log(`  * ${item.company} - ${item.title} (${itemReference(item)})`);
    console.log(`    Details: ${item.details.join(", ") || "Form complete"}`);
  }
  console.log("");

  console.log(`[4] MANUAL GATES / CAPTCHAS (${categories.MANUAL_GATE.length} items):`);
  if (categories.MANUAL_GATE.length === 0) {
    console.log("  None. No manual gates active.");
  } else {
    for (const item of categories.MANUAL_GATE) {
      console.log(`  * ${item.company} - ${item.title}`);
      console.log(`    Summary: ${item.summary}`);
      console.log(`    Action: ${item.suggestedAction}`);
    }
  }
  console.log("================================================================================");
}

export function buildAgentPrompt({ categories, uncompleted }: ReturnType<typeof readPipelineAudit>): string {
  const lines: string[] = [
    `[PIPELINE AUDIT: ${uncompleted.length} FINDINGS REQUIRING ATTENTION]`,
    `================================================================================`,
    `  MANDATE: PARALLELISM & SUBAGENT HAND-OFF (DO NOT FORGET CONTEXT)`,
    `================================================================================`,
    `1. PARALLELISM: Group independent ATS bugs below into isolated worktrees (/tmp/worktree-*)`,
    `   and dispatch concurrent subagents to investigate and fix.`,
    `2. SUBAGENT HAND-OFF: Follow the manager-worker pipeline rigorously:`,
    `   Implementer -> Fresh Independent Rechecker -> Commit Checkpoint -> Merge.`,
    `3. FACT INTEGRITY: Never invent candidate facts. Only prompt user for genuine missing facts.`,
    `================================================================================\n`
  ];

  for (const [heading, items] of [
    ["ATS BUGS TO DELEGATE TO PARALLEL WORKERS", categories.ATS_BUG],
    ["UNCONFIRMED SUBMISSIONS", categories.UNCONFIRMED_SUBMISSION],
    ["RUNS NEEDING EVIDENCE REVIEW", categories.RUN_NEEDS_REVIEW]
  ] as const) {
    if (items.length > 0) lines.push(`${heading} (${items.length} items):`, ...findingLines(items), "");
  }

  if (categories.MISSING_FACT.length > 0) {
    lines.push(`MISSING CANDIDATE FACTS (${categories.MISSING_FACT.length} items):`);
    for (const item of categories.MISSING_FACT) {
      lines.push(`  * ${item.company} (${item.title}): ${item.summary}`);
    }
    lines.push("");
  }

  if (categories.AWAITING_APPROVAL.length > 0) {
    lines.push(`AWAITING HUMAN OR POLICY APPROVAL (${categories.AWAITING_APPROVAL.length} items):`);
    for (const item of categories.AWAITING_APPROVAL) {
      lines.push(`  * ${item.company} (${item.title}) [${itemReference(item)}]`);
    }
    lines.push("");
  }

  lines.push("Instructions: Act as manager. Group confirmed ATS bugs into independent tracks, dispatch parallel subagents in isolated worktrees, and verify fixes with independent recheckers.");
  return lines.join("\n");
}

function isPaneIdle(socket: string, targetPane: string): boolean {
  try {
    const text1 = execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-t", targetPane], {
      encoding: "utf8",
      timeout: 3000
    });
    const lines = text1.split("\n").filter(Boolean);
    const bottom = lines.slice(-10).join("\n");
    if (/esc to cancel|to interrupt|Thinking\.\.\.|Running command|Thought for/i.test(bottom)) {
      return false;
    }
    const lastLines = lines.slice(-4).join("\n");
    if (!/>|❯|›|\?/i.test(lastLines)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function injectPrompt(socket: string, targetPane: string, promptText: string): boolean {
  const buffer = `pipeline_audit_${holdIdentity([socket, targetPane]).slice(0, 16)}`;
  try {
    execFileSync("tmux", ["-L", socket, "set-buffer", "-b", buffer, "--", promptText], { timeout: 3000, stdio: "ignore" });
    execFileSync("tmux", ["-L", socket, "paste-buffer", "-d", "-b", buffer, "-t", targetPane, "-p"], { timeout: 3000, stdio: "ignore" });
    execFileSync("tmux", ["-L", socket, "send-keys", "-t", targetPane, "Enter"], { timeout: 3000, stdio: "ignore" });
    return true;
  } catch {
    console.error("[pipeline:audit] Failed to inject prompt via tmux.");
    return false;
  }
}

export function readPipelineAudit(database: DatabaseSync, dataDir: string) {
  const rows = listApplicationAuditRuns(database);

  const submitted = rows.filter((r) => r.status === "submitted").length;
  const jobsWithRuns = new Set(rows.map((r) => r.job_id));
  const hasHolds = applicationHoldSchemaPresent(database);
  const uncompleted = [
    ...rows.filter((r) => r.status !== "submitted" && (!hasHolds || !applicationReceiptConfirmed(database, r.id)))
      .map((r) => categorizeRun(r, dataDir)),
    ...workdayAccountTimeouts(database, jobsWithRuns)
  ];
  return { total: rows.length, submitted, uncompleted, categories: auditCategories(uncompleted) };
}

function auditCategories(uncompleted: TriageItem[]) {
  return {
    ATS_BUG: uncompleted.filter((i) => i.category === "ATS_BUG"),
    UNCONFIRMED_SUBMISSION: uncompleted.filter((i) => i.category === "UNCONFIRMED_SUBMISSION"),
    RUN_NEEDS_REVIEW: uncompleted.filter((i) => i.category === "RUN_NEEDS_REVIEW"),
    MISSING_FACT: uncompleted.filter((i) => i.category === "MISSING_FACT"),
    MANUAL_GATE: uncompleted.filter((i) => i.category === "MANUAL_GATE"),
    AWAITING_APPROVAL: uncompleted.filter((i) => i.category === "AWAITING_APPROVAL")
  };
}

function managerItem(database: DatabaseSync, hold: ApplicationHold): TriageItem | null {
  const posting = getJobPosting(database, hold.jobId);
  if (!posting) return null;
  const run = hold.runId ? getBrowserRun(database, hold.runId) : null;
  const possible = hold.reason === "possible-submission";
  const account = hold.reason === "account-stop";
  const evidenceCommand = hold.runId ? `--run ${hold.runId.slice(0, 8)}` : `--job ${hold.jobId.slice(0, 8)}`;
  return {
    jobId: hold.jobId, runId: hold.runId, company: posting.companyName, title: posting.title,
    ats: run?.atsKind ?? "account step", status: run?.status ?? posting.status,
    category: possible ? "UNCONFIRMED_SUBMISSION" : account ? "ATS_BUG" : "RUN_NEEDS_REVIEW",
    summary: possible ? "Submission may have reached the employer." : account ? "The account step stopped before saving a run." : "The application needs automation or form review.",
    details: [],
    suggestedAction: `${possible ? "Check for a trusted receipt or portal confirmation before considering any retry." : "Inspect local evidence and verify the cause before changing or retrying anything."} Use pnpm run:evidence ${evidenceCommand}. Hold revision ${hold.revision}.`
  };
}

/** Returns whether this tick delivered new manager-owned revisions. */
export function deliverManagerAudit(input: {
  database: DatabaseSync; dataDir: string; destination: string; now?: Date;
  idle(): boolean; inject(prompt: string): boolean;
}): boolean {
  const { database, dataDir, destination } = input;
  const recipient = `manager:${holdIdentity(destination)}`;
  const release = acquireHoldDeliveryGuard(dataDir, recipient);
  if (!release) return false;
  try {
    const now = input.now ?? new Date();
    const fresh = refreshApplicationHolds(database, dataDir, now)
      .filter((hold) => hold.owner === "manager" && !applicationHoldDelivered(database, hold, recipient));
    if (!fresh.length || !input.idle()) return false;
    const included = fresh.flatMap((hold) => {
      const item = managerItem(database, hold);
      return item ? [{ hold, item }] : [];
    });
    if (!included.length) return false;
    const uncompleted = included.map(({ item }) => item);
    if (!input.inject(buildAgentPrompt({ total: uncompleted.length, submitted: 0, uncompleted, categories: auditCategories(uncompleted) }))) return false;
    acknowledgeApplicationHolds(database, included.map(({ hold }) => hold), recipient, now.toISOString());
    return true;
  } finally {
    release();
  }
}

function readTrace(database: DatabaseSync, reference: string) {
  if (!/^[0-9a-f-]{8,36}$/i.test(reference)) throw new Error("Supply a job or run reference of at least eight characters.");
  const ids = [
    ...findJobIds(database, reference).map((id) => ({ jobId: id, runId: undefined })),
    ...findBrowserRunIds(database, reference).flatMap((id) => {
      const run = getBrowserRun(database, id);
      return run ? [{ jobId: run.jobId, runId: run.id }] : [];
    })
  ];
  if (ids.length !== 1) throw new Error(ids.length ? "That reference is ambiguous." : "No job or run matches that reference.");
  const { jobId, runId } = ids[0]!;
  const hasHolds = applicationHoldSchemaPresent(database);
  return {
    events: hasHolds ? applicationHoldTrace(database, jobId, runId) : [],
    deliveries: hasHolds ? applicationHoldDeliveries(database, jobId, runId) : [],
    receipts: hasHolds ? applicationHoldReceiptChecks(database, jobId, runId) : [],
    evidenceCommand: `pnpm run:evidence ${runId ? `--run ${runId}` : `--job ${jobId}`}` };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const idx = args.indexOf(flag); return idx >= 0 ? args[idx + 1] : undefined; };
  const profile = workspaceProfileSchema.parse(value("--profile") ?? "real");
  const intervalSeconds = Math.max(10, Number.parseInt(value("--interval") ?? "60", 10) || 60);
  const isWatch = args.includes("--watch");
  const isJson = args.includes("--json");
  const shouldInject = args.includes("--inject");
  const tmuxSocket = value("--socket") || process.env.AI_TMUX_SOCKET || "ai";
  const tmuxPane = value("--pane") || process.env.TMUX_PANE || "internship-agent:0";

  const database = isWatch && shouldInject ? getProfileDatabase(profile) : openApplicationAuditDatabase(profile);
  const dataDir = resolveProfileDataDirectory(profile);
  if (args.includes("--trace")) {
    const reference = value("--trace");
    const afterReference = args[args.indexOf("--trace") + 2];
    if (!reference || isWatch || shouldInject || args.lastIndexOf("--trace") !== args.indexOf("--trace")
      || (afterReference !== undefined && !afterReference.startsWith("--"))) {
      throw new Error("--trace requires one job or run reference and cannot be combined with --watch or --inject.");
    }
    const trace = readTrace(database, reference);
    console.log(JSON.stringify({ ...trace, evidenceCommand: `${trace.evidenceCommand} --profile ${profile}` }, null, 2));
    database.close();
    return;
  }

  for (;;) {
    printAudit(profile, readPipelineAudit(database, dataDir), isJson);

    if (isWatch && shouldInject) {
      try {
        if (deliverManagerAudit({
          database, dataDir, destination: JSON.stringify([tmuxSocket, tmuxPane]),
          idle: () => isPaneIdle(tmuxSocket, tmuxPane), inject: (prompt) => injectPrompt(tmuxSocket, tmuxPane, prompt)
        })) console.log("[pipeline:audit] Injected changed manager findings.");
      } catch {
        console.error("[pipeline:audit] Could not refresh or acknowledge hold delivery; will retry.");
      }
    }

    if (!isWatch) break;
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
  database.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
