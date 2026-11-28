import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeProfileDatabase,
  createDatabase,
  getBrowserRun,
  logApplicationEvent,
  persistNormalizedPosting,
  resolveProfileDatabasePath,
  resolveProfileDataDirectory,
  saveBrowserRun
} from "@internship-agent/db";
import type { BrowserRun, PauseRecord } from "@internship-agent/domain";

import { runPipelinePass, runWatchTick } from "../../packages/agent/scripts/pipeline-pass";
import {
  buildDigest,
  classifyHold,
  collectDigestSnapshot,
  digestStatePath,
  readDigestState,
  sendDailyDigest,
  type DigestPause,
  type DigestRun,
  type DigestSnapshot
} from "../../packages/agent/src/daily-digest";
import { runAnswerCommand, runQuestionsCommand } from "../../packages/agent/src/run-answer";
import type { DiscordFetch } from "../../packages/agent/src/discord-notify";

/**
 * The daily Discord digest against a temporary data directory, a fake clock,
 * and an injected Discord fetch; the global fetch throws, so nothing reaches
 * the network. The collector reads a disposable workspace database.
 */
const TOKEN = "tok-DIGEST-SECRET-42";
const USER_ID = "123456789012345678";
const settings = { token: TOKEN, userId: USER_ID };
const discordEnv = ["INTERNSHIP_AGENT_DISCORD_BOT_TOKEN", "INTERNSHIP_AGENT_DISCORD_USER_ID", "GITHUB_TOKEN"];

let directory = "";
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "internship-agent-digest-"));
  saved = Object.fromEntries(["INTERNSHIP_AGENT_DATA_DIR", ...discordEnv].map((name) => [name, process.env[name]]));
  process.env.INTERNSHIP_AGENT_DATA_DIR = directory;
  for (const name of discordEnv) delete process.env[name];
  vi.stubGlobal("fetch", () => { throw new Error("network is not allowed in this suite"); });
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeProfileDatabase("real");
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);

const pause = (label: string, extra: Partial<DigestPause> = {}): DigestPause =>
  ({ label, status: "open", safeguard: false, upload: false, ...extra });
const run = (status: string, pauses: DigestPause[] = [], extra: Partial<DigestRun> = {}): DigestRun =>
  ({ id: randomUUID(), status, atsConfirmed: true, voiceDraft: false, pauses, ...extra });
const job = (companyName: string, title: string, held: DigestRun | null) => ({ jobId: randomUUID(), companyName, title, run: held });
const empty: DigestSnapshot = { applying: [], resumeTooLong: 0, sent: [], replies: [] };

/** A Discord fetch that answers the DM channel and records each message's content. */
function recordingFetch(status = 200) {
  const contents: string[] = [];
  let calls = 0;
  const fetch: DiscordFetch = async (url, init) => {
    calls += 1;
    if (status !== 200) return new Response("{}", { status });
    if (url.endsWith("/users/@me/channels")) return new Response(JSON.stringify({ id: "987654321" }), { status: 200 });
    contents.push(String((JSON.parse(String(init.body)) as { content: unknown }).content));
    return new Response("{}", { status: 200 });
  };
  return { fetch, contents, calls: () => calls };
}

describe("digest text", () => {
  it("says what each hold needs in plain words, numbered, with no internal status names", () => {
    const digest = buildDigest({
      ...empty,
      applying: [
        job("Datadog", "SWE Intern", run("paused-needs-input", [pause("Are you 21 or older?"), pause("Earliest start date?")])),
        job("Glowpath", "Platform Intern", run("paused-needs-input", [pause("Verify you are human", { safeguard: true })])),
        job("ServiceNow", "FDE Intern", run("awaiting-approval")),
        job("Acme", "Data Intern", run("awaiting-approval", [], { voiceDraft: true })),
        job("Globex", "ML Intern", run("paused-needs-input", [pause("Cover letter", { upload: true })]))
      ]
    }, at(20, 9))!;
    const lines = digest.text.split("\n");
    expect(lines[0]).toMatch(/^📋 Daily internship update — \w{3} Nov 20$/);
    expect(lines).toEqual([
      lines[0],
      "Waiting on you (5):",
      `1. Datadog SWE Intern — 2 questions: "Are you 21 or older?", "Earliest start date?"`,
      "2. Glowpath Platform Intern — solve a CAPTCHA, the only step left for you",
      `3. ServiceNow FDE Intern — ready, say "send ServiceNow"`,
      `4. Acme Data Intern — ready, check the drafted answer, then say "send Acme"`,
      `5. Globex ML Intern — 1 question: "Cover letter" (file)`,
      `Reply here with answers, e.g. "1: yes, May 15".`
    ]);
    for (const jargon of ["paused-needs-input", "awaiting-approval", "safeguard", "Q1"]) expect(digest.text).not.toContain(jargon);
  });

  it("shows at most two questions per item, then +N more", () => {
    const digest = buildDigest({
      ...empty,
      applying: [job("Stripe", "Intern", run("paused-needs-input", ["A?", "B?", "C?", "D?", "E?"].map((label) => pause(label))))]
    }, at(20, 9))!;
    expect(digest.text).toContain(`1. Stripe Intern — 5 questions: "A?", "B?" +3 more`);
    expect(digest.text).not.toContain(`"C?"`);
  });

  it("collapses holds the agent fixes itself into one count, and sends nothing for that count alone", () => {
    const fixing: DigestSnapshot = {
      ...empty,
      resumeTooLong: 1,
      applying: [
        job("Initech", "Intern", run("awaiting-approval", [], { atsConfirmed: false })),
        job("Umbrella", "Intern", run("paused-needs-input", [pause("Unlabeled input control 3")]))
      ]
    };
    expect(classifyHold(fixing.applying[0]!.run)).toEqual({ kind: "fixing" });
    expect(classifyHold(fixing.applying[1]!.run)).toEqual({ kind: "fixing" });
    expect(buildDigest(fixing, at(20, 9))).toBeNull();
    const digest = buildDigest({ ...fixing, sent: [{ jobId: randomUUID(), companyName: "Stripe" }] }, at(20, 9))!;
    expect(digest.text.split("\n").slice(1)).toEqual(["Sent since last update: 1 (Stripe)", "Being fixed automatically: 3"]);
    expect(digest.text).not.toContain("Initech");
    expect(digest.text).not.toContain("Unlabeled");
  });

  it("lists an unconfirmed run on a site the candidate approves each run on (Oracle) as ready, not as being fixed", () => {
    const oracle = run("awaiting-approval", [], { atsConfirmed: false, suggestedAtsKind: "oracle" });
    expect(classifyHold(oracle)).toEqual({ kind: "candidate", captcha: false, asks: [], ready: true, voiceDraft: false });
    const digest = buildDigest({ ...empty, applying: [job("Harbor", "Data Intern", oracle)] }, at(20, 9))!;
    expect(digest.text).toContain(`1. Harbor Data Intern — ready, say "send Harbor"`);
    expect(digest.text).not.toContain("Being fixed");
    // An unrecognized site still waits on the agent.
    expect(classifyHold(run("awaiting-approval", [], { atsConfirmed: false, suggestedAtsKind: null }))).toEqual({ kind: "fixing" });
  });

  it("never reads the hidden CAPTCHA token field as a CAPTCHA or a question", () => {
    const token = run("paused-needs-input", [pause("g-recaptcha-response", { safeguard: true })]);
    expect(classifyHold(token)).toEqual({ kind: "fixing" });
    const mixed = run("paused-needs-input", [pause("h-captcha-response-1", { safeguard: true }), pause("Earliest start date?")]);
    expect(classifyHold(mixed)).toEqual({ kind: "candidate", captcha: false, asks: [`"Earliest start date?"`], ready: false });
    const digest = buildDigest({ ...empty, sent: [{ jobId: randomUUID(), companyName: "Stripe" }], applying: [job("Lumora", "Intern", token)] }, at(20, 9))!;
    expect(digest.text).not.toContain("CAPTCHA");
    expect(digest.text).not.toContain("g-recaptcha-response");
  });

  it("shows manual field corrections by original question number apart from visible CAPTCHAs", () => {
    const held = run("paused-needs-input", [
      pause("Unlabeled input control 1"),
      pause("Applicant jordan@example.test", { fieldId: "site-error-1", safeguard: true }),
      pause("Verify that you are human", { fieldId: "captcha", safeguard: true })
    ]);
    const digest = buildDigest({ ...empty, holdDelivery: true, applying: [job("Fixture", "Intern", held)] }, at(20, 9))!;
    expect(digest.text).toContain('solve a CAPTCHA; fix in the browser: Q2 "Applicant [email]"');
    expect(digest.text).not.toMatch(/reply here|jordan@example.test/i);
    expect(classifyHold(run("awaiting-approval", [], { submissionApprovedAt: at(20, 9).toISOString() }))).toEqual({ kind: "fixing" });
  });

  it("returns nothing when there is nothing to report", () => {
    expect(buildDigest(empty, at(20, 9))).toBeNull();
    // Runs that are not held (submitted, failed) and answered questions are not waiting on anyone.
    expect(buildDigest({ ...empty, applying: [job("A", "B", run("failed")), job("C", "D", run("paused-needs-input", [pause("Q", { status: "answered" })]))] }, at(20, 9)))
      .toBeNull();
  });

  it("summarizes sent applications and company replies, and redacts what free text may carry", () => {
    const digest = buildDigest({
      applying: [job("Acme", "Intern", run("paused-needs-input", [pause("Email jane.doe@example.com or call 5551234567?")]))],
      resumeTooLong: 0,
      sent: [{ jobId: randomUUID(), companyName: "Stripe" }, { jobId: randomUUID(), companyName: "Corvane" }],
      replies: [{ companyName: "Acme", kind: "interview" }, { companyName: "Globex", kind: "rejection" }, { companyName: "Initech", kind: "rejection" }]
    }, at(20, 9))!;
    expect(digest.text).toContain("Sent since last update: 2 (Stripe, Corvane)");
    expect(digest.text).toContain("Replies from companies: 1 interview invite (Acme), 2 rejections (Globex, Initech)");
    expect(digest.text).toContain(`"Email [email] or call [number]?"`);
    expect(digest.text.split("\n").length).toBeLessThanOrEqual(15);
  });

  it("stays short: at most eight items, then a count", () => {
    const applying = Array.from({ length: 11 }, (_, index) => job(`Co${index + 1}`, "Intern", run("awaiting-approval")));
    const digest = buildDigest({ ...empty, applying }, at(20, 9))!;
    expect(digest.items.map((item) => item.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(digest.text).toContain("Waiting on you (11):");
    expect(digest.text).toContain("…and 3 more");
    expect(digest.text.split("\n").length).toBeLessThanOrEqual(15);
  });
});

describe("daily send", () => {
  const snapshot: DigestSnapshot = {
    ...empty,
    applying: [job("Datadog", "SWE Intern", run("paused-needs-input", [pause("Are you 21 or older?")])), job("ServiceNow", `FDE ${TOKEN}`, run("awaiting-approval"))]
  };

  it("sends once a day at or after 09:00, and again the next day", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    const discord = recordingFetch();
    const send = (now: Date) => sendDailyDigest({ dataDir, settings, now, read: () => snapshot, transport: { fetch: discord.fetch }, log: () => undefined });

    expect(await send(at(20, 8, 59))).toBe("not-due");
    expect(discord.calls()).toBe(0);
    expect(await send(at(20, 9, 0))).toBe("sent");
    expect(discord.contents).toHaveLength(1);
    expect(await send(at(20, 9, 5))).toBe("not-due");
    expect(await send(at(20, 23, 59))).toBe("not-due");
    expect(await send(at(21, 7, 0))).toBe("not-due");
    expect(await send(at(21, 9, 30))).toBe("sent");
    expect(discord.contents).toHaveLength(2);
  });

  it("saves the digest number to run mapping", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    const discord = recordingFetch();
    await sendDailyDigest({ dataDir, settings, now: at(20, 10), read: () => snapshot, transport: { fetch: discord.fetch }, log: () => undefined });
    const state = readDigestState(dataDir);
    expect(state.lastSentDate).toBe("2026-11-20");
    expect(state.items).toEqual([
      { number: 1, runId: snapshot.applying[0]!.run!.id, jobId: snapshot.applying[0]!.jobId, company: "Datadog" },
      { number: 2, runId: snapshot.applying[1]!.run!.id, jobId: snapshot.applying[1]!.jobId, company: "ServiceNow" }
    ]);
  });

  it("sends nothing when there is nothing to report, and stays due", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    const discord = recordingFetch();
    const lines: string[] = [];
    expect(await sendDailyDigest({ dataDir, settings, now: at(20, 10), read: () => empty, transport: { fetch: discord.fetch }, log: (line) => lines.push(line) }))
      .toBe("nothing");
    expect(discord.calls()).toBe(0);
    expect(lines).toEqual([]);
    expect(await sendDailyDigest({ dataDir, settings, now: at(20, 15), read: () => snapshot, transport: { fetch: discord.fetch }, log: () => undefined }))
      .toBe("sent");
  });

  it("never puts the token in the message, the log, or the state file", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    const discord = recordingFetch();
    const lines: string[] = [];
    await sendDailyDigest({ dataDir, settings, now: at(20, 10), read: () => snapshot, transport: { fetch: discord.fetch }, log: (line) => lines.push(line) });
    expect(discord.contents.join("\n")).toContain("[redacted]");
    expect(discord.contents.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(readFileSync(digestStatePath(dataDir), "utf8")).not.toContain(TOKEN);

    const failing = recordingFetch(401);
    const failed: string[] = [];
    await sendDailyDigest({ dataDir, settings, now: at(21, 10), read: () => snapshot, transport: { fetch: failing.fetch }, log: (line) => failed.push(line) });
    expect(failed).toEqual(["Discord digest failed: 401"]);
  });

  it("does nothing without the Discord settings", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    const read = vi.fn(() => snapshot);
    expect(await sendDailyDigest({ dataDir, settings: null, now: at(20, 10), read, log: () => undefined })).toBe("off");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("watcher tick", () => {
  const noLists = async () => new Response("unused");

  it("a failed digest never fails the tick, and is retried an hour later", async () => {
    process.env.INTERNSHIP_AGENT_DISCORD_BOT_TOKEN = TOKEN;
    process.env.INTERNSHIP_AGENT_DISCORD_USER_ID = USER_ID;
    createDatabase(resolveProfileDatabasePath("real")).close();
    const snapshot: DigestSnapshot = { ...empty, sent: [{ jobId: randomUUID(), companyName: "Stripe" }] };
    const failing = recordingFetch(500);
    const lines: string[] = [];
    const tick = (now: Date, fetch: DiscordFetch) =>
      runWatchTick({ profile: "real", log: (line) => lines.push(line), fetcher: noLists, digest: { now: () => now, transport: { fetch }, read: () => snapshot } });

    await expect(tick(at(20, 9, 0), failing.fetch)).resolves.toBeUndefined();
    expect(lines).toEqual(["Discord digest failed: 500"]);
    await tick(at(20, 9, 30), failing.fetch);
    expect(lines).toHaveLength(1);
    const working = recordingFetch();
    await tick(at(20, 10, 1), working.fetch);
    expect(working.contents).toHaveLength(1);
    expect(lines.at(-1)).toBe("Discord digest: sent (0 waiting on you).");

    // A read that throws is logged the same way, never thrown.
    const broken = { now: () => at(21, 9), transport: { fetch: working.fetch }, read: (): DigestSnapshot => { throw new Error(`boom ${TOKEN}`); } };
    await expect(runWatchTick({ profile: "real", log: (line) => lines.push(line), fetcher: noLists, digest: broken })).resolves.toBeUndefined();
    expect(lines.at(-1)).toBe("Discord digest failed: unexpected error");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("reads the workspace: held runs, sends and replies since the last digest, resume holds", async () => {
    process.env.INTERNSHIP_AGENT_DISCORD_BOT_TOKEN = TOKEN;
    process.env.INTERNSHIP_AGENT_DISCORD_USER_ID = USER_ID;
    const seed = createDatabase(resolveProfileDatabasePath("real"));
    const datadog = posting(seed, "Datadog", "SWE Intern", "APPLYING");
    const datadogRun = heldRun(seed, datadog, "paused-needs-input", [openPause("Are you 21 or older?"), openPause("Earliest start date?"), openPause("Unlabeled input control 9")]);
    const heart = posting(seed, "Glowpath", "Platform Intern", "APPLYING");
    heldRun(seed, heart, "paused-needs-input", [{ ...openPause("Verify you are human"), safeguard: true }]);
    const unknownSite = posting(seed, "Initech", "Intern", "APPLYING");
    heldRun(seed, unknownSite, "awaiting-approval", [], false);
    const stripe = posting(seed, "Stripe", "Intern", "SUBMITTED");
    logApplicationEvent(seed, { jobId: stripe, fromStatus: "APPLYING", toStatus: "SUBMITTED", detail: "Submitted automatically." });
    logApplicationEvent(seed, { jobId: stripe, fromStatus: "SUBMITTED", toStatus: "SUBMITTED", detail: `Email received: Interview invite from stripe.com: "Next steps"` });
    const old = posting(seed, "Oldco", "Intern", "SUBMITTED");
    logApplicationEvent(seed, { jobId: old, fromStatus: "APPLYING", toStatus: "SUBMITTED" });
    seed.prepare("UPDATE application_events SET created_at = ? WHERE job_id = ?").run("2026-01-01T00:00:00.000Z", old);
    const longResume = posting(seed, "Hooli", "Intern", "READY_FOR_REVIEW");
    logApplicationEvent(seed, { jobId: longResume, fromStatus: "READY_FOR_REVIEW", toStatus: "READY_FOR_REVIEW",
      detail: "Automatic browser run failed: The generated resume runs to 2 pages. Trim or archive entries on the Resume page, then prepare the application again." });
    seed.close();

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const database = createDatabase(resolveProfileDatabasePath("real"));
    const snapshot = collectDigestSnapshot(database, since);
    database.close();
    expect(snapshot.resumeTooLong).toBe(1);
    expect(snapshot.sent.map((entry) => entry.companyName)).toEqual(["Stripe"]);
    expect(snapshot.replies).toEqual([{ companyName: "Stripe", kind: "interview" }]);
    expect(snapshot.applying.map((entry) => entry.companyName).sort()).toEqual(["Datadog", "Glowpath", "Initech"]);

    // The tick's own reader: a fake clock late today, so today's events fall in the first digest's window.
    const now = new Date();
    now.setHours(23, 59, 0, 0);
    const discord = recordingFetch();
    const lines: string[] = [];
    await runWatchTick({ profile: "real", log: (line) => lines.push(line), fetcher: noLists, digest: { now: () => now, transport: { fetch: discord.fetch } } });
    expect(lines).toEqual(["Discord digest: sent (2 waiting on you)."]);
    const text = discord.contents.join("\n");
    expect(text).toContain("Sent since last update: 1 (Stripe)");
    expect(text).toContain(`Datadog SWE Intern — 2 questions: Q1 "Are you 21 or older?", Q2 "Earliest start date?"`);
    expect(text).toContain("Glowpath Platform Intern — solve a CAPTCHA");
    expect(text).not.toContain("Being fixed automatically");
    expect(text).toContain("Replies from companies: 1 interview invite (Stripe)");
    expect(text).not.toContain("Oldco");
    expect(text).not.toContain("Unlabeled");
    expect(text).not.toContain("Submitted automatically.");
    expect(text).not.toContain("Next steps");
    const state = readDigestState(resolveProfileDataDirectory("real"));
    expect(state.items.find((item) => item.company === "Datadog")?.runId).toBe(datadogRun);
  });

  it("shares candidate delivery with pass notices and retains digest mappings on summary-only delivery", async () => {
    process.env.INTERNSHIP_AGENT_DISCORD_BOT_TOKEN = TOKEN;
    process.env.INTERNSHIP_AGENT_DISCORD_USER_ID = USER_ID;
    const seed = createDatabase(resolveProfileDatabasePath("real"));
    const first = posting(seed, "First", "Intern", "APPLYING");
    const firstRun = heldRun(seed, first, "paused-needs-input", [openPause("Unlabeled input control 1"), openPause("Which editor do you use?")]);
    seed.close();
    const dataDir = resolveProfileDataDirectory("real");
    const discord = recordingFetch();
    const now = new Date();
    now.setHours(23, 50, 0, 0);
    await runWatchTick({ profile: "real", log: () => undefined, fetcher: noLists, digest: { now: () => now, transport: { fetch: discord.fetch } } });
    expect(readDigestState(dataDir).items[0]?.runId).toBe(firstRun);

    const adding = createDatabase(resolveProfileDatabasePath("real"));
    const second = posting(adding, "Second", "Intern", "APPLYING");
    heldRun(adding, second, "paused-needs-input", [openPause("Unlabeled input control 1"), {
      ...openPause("Applicant jordan@example.test"), fieldId: "site-error-1", safeguard: true
    }]);
    const sent = posting(adding, "Sentco", "Intern", "SUBMITTED");
    logApplicationEvent(adding, { jobId: sent, fromStatus: "APPLYING", toStatus: "SUBMITTED", detail: "Fixture submitted" });
    adding.prepare("UPDATE application_events SET created_at = ? WHERE job_id = ?").run(new Date(now.getTime() + 1000).toISOString(), sent);
    adding.close();

    await runPipelinePass({ profile: "real", sourceIds: [], log: () => undefined, notify: { fetch: discord.fetch },
      advance: async () => ({ analyzed: [], prepared: [], started: [], stopped: [], waiting: [], held: [], skipped: [], submitted: [], errors: [] }) });
    expect(discord.contents[1]).toContain('Q2 fix this field in the browser: "Applicant [email]"');
    expect(discord.contents[1]).not.toContain("CAPTCHA");
    expect(discord.contents[1]).not.toMatch(/Unlabeled|Q1|First/);

    const following = new Date(now);
    following.setDate(following.getDate() + 1);
    await runWatchTick({ profile: "real", log: () => undefined, fetcher: noLists, digest: { now: () => following, transport: { fetch: discord.fetch } } });
    expect(discord.contents[2]).toContain("Sent since last update: 1 (Sentco)");
    expect(discord.contents[2]).not.toContain("Waiting on you");
    expect(readDigestState(dataDir).items[0]?.runId).toBe(firstRun);
    const listed: string[] = [];
    expect(await runQuestionsCommand(["--digest", "1"], { log: (line) => listed.push(line) })).toBe(0);
    expect(listed.join("\n")).toContain("asks in this order: Q2");
    expect(listed.join("\n")).toContain('Q1: "Unlabeled input control 1"');
    const answerLog: string[] = [];
    const answerStatus = await runAnswerCommand(["--digest", "1", "--q", "2", "--answer", "Example editor", "--once"], { log: (line) => answerLog.push(line) });
    expect(answerStatus, answerLog.join("\n")).toBe(0);
    const checked = createDatabase(resolveProfileDatabasePath("real"));
    expect(getBrowserRun(checked, firstRun)?.pauses.map((pause) => pause.status)).toEqual(["open", "answered"]);
    checked.close();
  });

  it("never counts a security or verification code email as a company reply, under the new or the older label", () => {
    const seed = createDatabase(resolveProfileDatabasePath("real"));
    const tidewave = posting(seed, "Tidewave", "Software Engineering Intern", "APPLYING");
    const globex = posting(seed, "Globex", "Intern", "APPLYING");
    const acme = posting(seed, "Acme", "Intern", "SUBMITTED");
    const note = (jobId: string, detail: string) => logApplicationEvent(seed, { jobId, fromStatus: "APPLYING", toStatus: "APPLYING", detail });
    // The older watcher filed Greenhouse's security-code email as a recruiter reply; the new one files it as a verification code.
    note(tidewave, `Email received: Recruiter reply from us.greenhouse-mail.io: "Security code for your application to Tidewave"`);
    note(tidewave, `Email received: Verification code from us.greenhouse-mail.io: "Security code for your application to Tidewave"`);
    note(globex, `Email received: Verification code from globex.myworkday.com: "Verify your account"`);
    note(acme, `Email received: Recruiter reply from acme.com: "About your application"`);
    seed.close();

    const database = createDatabase(resolveProfileDatabasePath("real"));
    const snapshot = collectDigestSnapshot(database, new Date(Date.now() - 60 * 60 * 1000).toISOString());
    database.close();
    expect(snapshot.replies).toEqual([{ companyName: "Acme", kind: "recruiter" }]);
  });
});

function posting(database: DatabaseSync, companyName: string, title: string, status: string): string {
  const sourceUrl = `https://example.test/${companyName.toLowerCase()}/${randomUUID()}`;
  const { jobId } = persistNormalizedPosting(database, {
    companyName, title, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
    sourceUrl, externalApplicationUrl: null, companyCareersUrl: null,
    contentHash: `hash-${sourceUrl}`, normalizedText: `${title}\nFixture posting for the digest.`,
    locations: [], compensation: null, requirements: [], technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  });
  database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, jobId);
  return jobId;
}

function openPause(label: string): PauseRecord {
  return {
    fieldId: randomUUID(), label, question: label, suggestedKey: null, suggestedScope: null, safeguard: false, sensitive: false,
    upload: false, status: "open", answer: null, draft: null
  };
}

function heldRun(database: DatabaseSync, jobId: string, status: BrowserRun["status"], pauses: PauseRecord[], atsConfirmed = true): string {
  const packageId = randomUUID();
  database.prepare("INSERT INTO application_packages (id, job_id, created_at, package_json) VALUES (?, ?, ?, ?)")
    .run(packageId, jobId, new Date().toISOString(), "{}");
  const now = new Date().toISOString();
  return saveBrowserRun(database, {
    id: randomUUID(), jobId, applicationUrl: "https://example.test/apply", status, packageId, variantId: null, baseResumeId: null,
    atsKind: "greenhouse", atsConfidence: 1, suggestedAtsKind: null, atsConfirmed, decisions: [], pauses,
    submittedAnswers: null, confirmationText: null, submissionApprovedAt: null, createdAt: now, updatedAt: now
  }).id;
}
