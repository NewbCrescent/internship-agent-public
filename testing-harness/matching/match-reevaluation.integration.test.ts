import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  getJobMatch,
  getJobPosting,
  LOCAL_CANDIDATE_ID,
  persistNormalizedPosting,
  saveCandidate,
  saveCandidatePreferences,
  saveDiscoverySkip,
  saveJobMatch,
  statusForVerdict,
  type NormalizedPostingInput
} from "@internship-agent/db";
import type { JobMatchReport, JobRequirement } from "@internship-agent/domain";
import {
  acquirePipelineLock,
  evaluateAndPersistMatch,
  LEFT_IN_PLACE,
  REEVALUATE_USAGE,
  REEVALUATION_EVENT_PREFIX,
  REEVALUATION_SKIPS,
  reevaluateMatches,
  reevaluationGate,
  runMatchReevaluationCommand
} from "@internship-agent/agent";

/**
 * `pnpm matches:reevaluate` (Track 56): a dry run writes nothing, and --apply
 * writes only changed verdicts of postings still in analysis whose status
 * matches their stored verdict and that were never prepared or run.
 * Fictional companies; titles modelled on stored board titles.
 */
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const STALE_REASON = "The internship title targets a Master's or PhD candidate, excluded by the saved preference.";
const BOSTON_TITLE = "Software Engineer Intern - Boston, MA";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type Workspace = {
  directory: string;
  path: string;
  database: DatabaseSync;
  ids: Record<"p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7", string>;
};

function staleReport(jobId: string, verdict: "NOT_QUALIFIED" | "QUALIFIED" = "NOT_QUALIFIED"): JobMatchReport {
  return {
    jobId,
    verdict,
    eligible: verdict !== "NOT_QUALIFIED",
    fitScore: 40,
    findings: verdict === "NOT_QUALIFIED"
      ? [{ subject: "DEGREE", requirementId: null, outcome: "FAIL", reason: STALE_REASON, statedExcerpt: BOSTON_TITLE }]
      : [],
    reasons: [],
    evaluatedAt: "2026-11-20T12:00:00.000Z",
    scoringVersion: 2
  };
}

function postingInput(
  key: string,
  companyName: string,
  title: string,
  options: { boston?: boolean; requirement?: string; labelsPending?: string } = {}
): NormalizedPostingInput {
  const location = "Boston, MA";
  const body = `${title}. ${companyName} builds fictional products for tests. Interns work with the engineering team for twelve weeks.`;
  const normalizedText = options.boston ? `${location}. ${body}${options.requirement ? ` ${options.requirement}` : ""}`
    : `${body}${options.requirement ? ` ${options.requirement}` : ""}`;
  const requirements: Array<Omit<JobRequirement, "id" | "jobId">> = [];
  if (options.requirement) {
    const start = normalizedText.indexOf(options.requirement);
    requirements.push({
      text: options.requirement, category: "HARD", subject: "SKILL", extraction: "MODEL", assertion: "STATED", confidence: 0.9,
      span: { start, end: start + options.requirement.length, excerpt: options.requirement }
    });
  }
  return {
    companyName, title, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
    sourceUrl: `https://example.test/jobs/${key}`, externalApplicationUrl: null, companyCareersUrl: null,
    contentHash: `reevaluate-${key}`, normalizedText,
    locations: options.boston ? [{
      raw: location, city: "Boston", region: "MA", countryCode: "US", workMode: "UNSPECIFIED",
      span: { start: 0, end: location.length, excerpt: location }
    }] : [],
    compensation: null, technologies: [], requirements,
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null },
    ...(options.labelsPending ? { requirementLabelsPending: options.labelsPending } : {})
  };
}

function workspace(): Workspace {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-reevaluate-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "test.sqlite");
  const database = createDatabase(path);
  saveCandidate(database, LOCAL_CANDIDATE_ID, { fullName: "Jordan Rivera", degree: "B.S. Computer Science" });
  saveCandidatePreferences(database, LOCAL_CANDIDATE_ID, {
    roleTypes: [], locations: [], workModes: [], industries: [], excludeGraduateOnlyInternships: true
  });
  const add = (input: NormalizedPostingInput) => persistNormalizedPosting(database, input).jobId;
  const setStatus = (jobId: string, status: string) => database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, jobId);

  const p1 = add(postingInput("p1", "Harbor Lights Co", BOSTON_TITLE, { boston: true }));
  saveJobMatch(database, staleReport(p1));
  const p2 = add(postingInput("p2", "Quanta Fixture Labs", "Research Intern (MS/PhD)"));
  evaluateAndPersistMatch(p2, { database, candidateId: LOCAL_CANDIDATE_ID });
  const p3 = add(postingInput("p3", "Submitted Fixture Inc", BOSTON_TITLE, { boston: true }));
  saveJobMatch(database, staleReport(p3));
  setStatus(p3, "SUBMITTED");
  const p4 = add(postingInput("p4", "Approved Fixture Inc", BOSTON_TITLE, { boston: true }));
  saveJobMatch(database, staleReport(p4));
  setStatus(p4, "APPROVED");
  const p5 = add(postingInput("p5", "Skipped Fixture Inc", BOSTON_TITLE, { boston: true }));
  saveJobMatch(database, staleReport(p5));
  setStatus(p5, "READY_FOR_REVIEW");
  saveDiscoverySkip(database, { jobId: p5, reason: "Posting closed", preferenceNote: null });
  const p6 = add(postingInput("p6", "Closed By Hand Co", BOSTON_TITLE, { boston: true, requirement: "Experience with COBOL" }));
  saveJobMatch(database, staleReport(p6, "QUALIFIED"));
  setStatus(p6, "NOT_QUALIFIED");
  const p7 = add(postingInput("p7", "Held Labels Co", BOSTON_TITLE, { boston: true, labelsPending: "labels unavailable (test)" }));
  saveJobMatch(database, staleReport(p7));
  return { directory, path, database, ids: { p1, p2, p3, p4, p5, p6, p7 } };
}

function snapshot(database: DatabaseSync) {
  return {
    jobs: database.prepare("SELECT * FROM jobs ORDER BY id").all(),
    matches: database.prepare("SELECT * FROM job_matches ORDER BY job_id").all(),
    events: database.prepare("SELECT * FROM application_events ORDER BY id").all()
  };
}

function rows(database: DatabaseSync, jobId: string) {
  return {
    job: database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId),
    match: database.prepare("SELECT * FROM job_matches WHERE job_id = ?").get(jobId)
  };
}

function eventsFor(database: DatabaseSync, jobId: string) {
  return database.prepare("SELECT * FROM application_events WHERE job_id = ? ORDER BY created_at").all(jobId) as Array<{ detail: string | null }>;
}

describe("match re-evaluation", () => {
  it("a dry run changes nothing", () => {
    const { database, path } = workspace();
    const before = snapshot(database);
    const readOnly = new DatabaseSync(path, { readOnly: true });
    const report = reevaluateMatches(readOnly, { apply: false });
    readOnly.close();

    const p1 = report.changed.find((posting) => posting.companyName === "Harbor Lights Co");
    expect(p1).toMatchObject({ title: BOSTON_TITLE, from: "NOT_QUALIFIED" });
    expect(p1?.to).not.toBe("NOT_QUALIFIED");
    for (const company of ["Submitted Fixture Inc", "Approved Fixture Inc", "Skipped Fixture Inc", "Held Labels Co"]) {
      expect(report.changed.some((posting) => posting.companyName === company), company).toBe(false);
      expect(report.leftInPlace.some((posting) => posting.companyName === company), company).toBe(false);
    }
    expect(report.leftInPlace).toEqual([
      expect.objectContaining({ companyName: "Closed By Hand Co", from: "QUALIFIED", reason: LEFT_IN_PLACE.setApart })
    ]);
    expect(report.skipped[REEVALUATION_SKIPS.submitted]).toBe(1);
    expect(report.skipped[REEVALUATION_SKIPS.approved]).toBe(1);
    expect(report.skipped[REEVALUATION_SKIPS.candidateSkipped]).toBe(1);
    expect(report.skipped[REEVALUATION_SKIPS.labelHeld]).toBe(1);
    expect(report.errors).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(UUID);
    expect(snapshot(database)).toEqual(before);
    database.close();
  });

  it("--apply updates only non-terminal postings", () => {
    const { database, ids } = workspace();
    const untouched = (["p2", "p3", "p4", "p5", "p6", "p7"] as const).map((key) => [key, rows(database, ids[key])] as const);

    const report = reevaluateMatches(database, { apply: true });
    const fresh = getJobMatch(database, ids.p1);
    expect(fresh?.verdict).not.toBe("NOT_QUALIFIED");
    expect(report.changed).toEqual([{ companyName: "Harbor Lights Co", title: BOSTON_TITLE, from: "NOT_QUALIFIED", to: fresh?.verdict }]);
    expect(getJobPosting(database, ids.p1)?.status).toBe(statusForVerdict(fresh!.verdict));
    const events = eventsFor(database, ids.p1).filter((event) => event.detail?.startsWith(REEVALUATION_EVENT_PREFIX));
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toBe(`${REEVALUATION_EVENT_PREFIX}NOT_QUALIFIED → ${fresh!.verdict}.`);
    for (const [key, before] of untouched) expect(rows(database, ids[key]), key).toEqual(before);

    const eventCount = snapshot(database).events.length;
    const again = reevaluateMatches(database, { apply: true });
    expect(again.changed).toEqual([]);
    expect(snapshot(database).events).toHaveLength(eventCount);
    database.close();
  });

  it("--job limits it to one posting", () => {
    const { database, ids } = workspace();
    const report = reevaluateMatches(database, { apply: false, jobId: ids.p1 });
    expect(report.evaluated).toBe(1);
    expect(report.changed.map((posting) => posting.companyName)).toEqual(["Harbor Lights Co"]);
    database.close();
  });

  it("the command takes the pipeline lock on --apply and prints no job id", () => {
    const { database, path, directory, ids } = workspace();
    let output: string[] = [];
    let writable: DatabaseSync | null = null;
    const deps = {
      log: (line: string) => output.push(line),
      openReadOnly: () => new DatabaseSync(path, { readOnly: true }),
      openForWrite: () => (writable = createDatabase(path)),
      closeForWrite: () => {
        writable?.close();
        writable = null;
      },
      dataDir: () => directory,
      acquireLock: acquirePipelineLock
    };

    const before = snapshot(database);
    const release = acquirePipelineLock(directory);
    expect(runMatchReevaluationCommand(["--profile", "demo", "--apply"], deps)).toBe(1);
    expect(output.join("\n")).toContain("Not started:");
    expect(snapshot(database)).toEqual(before);
    output = [];
    expect(runMatchReevaluationCommand(["--profile", "demo"], deps)).toBe(0);
    expect(output.join("\n")).toContain("Dry run: nothing was written.");
    expect(snapshot(database)).toEqual(before);
    release();

    output = [];
    expect(runMatchReevaluationCommand(["--profile", "demo", "--apply"], deps)).toBe(0);
    expect(existsSync(join(directory, "pipeline.lock"))).toBe(false);
    const printed = output.join("\n");
    expect(printed).toContain("MATCH_REEVALUATION_REPORT ");
    expect(printed).toContain(`Harbor Lights Co — ${BOSTON_TITLE}`);
    expect(printed).not.toContain("Dry run");
    expect(output.some((line) => UUID.test(line))).toBe(false);
    expect(getJobPosting(database, ids.p1)?.status).not.toBe("NOT_QUALIFIED");

    output = [];
    expect(runMatchReevaluationCommand(["--profile", "demo", "--job", ids.p1.slice(0, 8)], deps)).toBe(0);
    expect(output[0]).toBe("Match re-evaluation (demo, dry run): 1 evaluated.");

    for (const args of [["--profile", "demo", "--force"], [], ["--apply"], ["--profile"], ["--profile", "demo", "--profile", "real"]]) {
      output = [];
      expect(runMatchReevaluationCommand(args, deps), args.join(" ")).toBe(1);
      expect(output).toEqual([REEVALUATE_USAGE]);
    }
    output = [];
    expect(runMatchReevaluationCommand(["--profile", "demo", "--job", "ffffffff"], deps)).toBe(1);
    expect(output).toEqual(['No job matches "ffffffff".']);
    database.close();
  });

  it("gates postings by status, browser runs, and packages (pure)", () => {
    const gate = (overrides: Partial<Parameters<typeof reevaluationGate>[0]>) => reevaluationGate({
      status: "ANALYZING", storedVerdict: "NEEDS_REVIEW", discoverySkipped: false, labelHeld: false, runStatuses: [], prepared: false,
      ...overrides
    });
    expect(gate({ status: "APPLYING", runStatuses: ["awaiting-approval"] })).toEqual({ kind: "skip", reason: REEVALUATION_SKIPS.applying });
    expect(gate({ status: "APPLYING", runStatuses: ["failed"] })).toEqual({ kind: "skip", reason: REEVALUATION_SKIPS.applying });
    expect(gate({ status: "APPLYING", runStatuses: ["cancelled"], prepared: true }))
      .toEqual({ kind: "evaluate", leftInPlace: LEFT_IN_PLACE.inProgress });
    expect(gate({ status: "READY_FOR_REVIEW", prepared: true })).toEqual({ kind: "evaluate", leftInPlace: LEFT_IN_PLACE.inProgress });
    expect(gate({ status: "NOT_QUALIFIED", storedVerdict: "QUALIFIED" })).toEqual({ kind: "evaluate", leftInPlace: LEFT_IN_PLACE.setApart });
    expect(gate({})).toEqual({ kind: "evaluate", leftInPlace: null });
    for (const status of ["SUBMITTED", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"] as const) {
      expect(gate({ status }), status).toEqual({ kind: "skip", reason: REEVALUATION_SKIPS.submitted });
    }
    expect(gate({ status: "APPROVED" })).toEqual({ kind: "skip", reason: REEVALUATION_SKIPS.approved });
    expect(gate({ status: "QUALIFIED", storedVerdict: "QUALIFIED", discoverySkipped: true }))
      .toEqual({ kind: "skip", reason: REEVALUATION_SKIPS.candidateSkipped });
    expect(gate({ labelHeld: true })).toEqual({ kind: "skip", reason: REEVALUATION_SKIPS.labelHeld });
  });
});
