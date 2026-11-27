import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearWorkdayAccountHold,
  getWorkdayAccount,
  listWorkdayAccounts,
  MailboxUnavailable,
  pollPasswordResetLink,
  pollVerificationLink,
  putWorkdayAccount,
  readWorkdayAccounts,
  workdayAccountWait,
  WorkdayAccountsFileError,
  type MailMessage,
  type VerificationMailbox,
  type WorkdayAccountEntry
} from "@internship-agent/agent";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-workday-store-"));
  directories.push(directory);
  return directory;
}

const HOST = "acme.wd1.myworkdayjobs.com";
const entry = (overrides: Partial<WorkdayAccountEntry> = {}): WorkdayAccountEntry => ({
  host: HOST, email: "jordan@example.test", password: "Fixture-Pass-123!", account: "created", hold: null,
  createdAt: "2026-11-19T12:00:00.000Z", updatedAt: "2026-11-19T12:00:00.000Z", ...overrides
});

describe("the Workday accounts file", () => {
  it("round-trips entries with owner-only permissions and leaves no temporary files", () => {
    const file = join(scratch(), "config", "nested", "workday-accounts.json");
    putWorkdayAccount(file, entry());
    putWorkdayAccount(file, entry({ host: "other.wd5.myworkdayjobs.com", password: null, account: null }));
    expect(getWorkdayAccount(file, HOST)).toEqual(entry());
    expect(Object.keys(readWorkdayAccounts(file)).sort()).toEqual([HOST, "other.wd5.myworkdayjobs.com"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(file, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("tightens a directory that already exists with wider permissions", () => {
    const directory = join(scratch(), "open");
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
    const file = join(directory, "workday-accounts.json");
    putWorkdayAccount(file, entry());
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a damaged file and never overwrites it", () => {
    const file = join(scratch(), "workday-accounts.json");
    writeFileSync(file, "{ not json");
    expect(() => readWorkdayAccounts(file)).toThrow(WorkdayAccountsFileError);
    expect(() => putWorkdayAccount(file, entry())).toThrow(WorkdayAccountsFileError);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    writeFileSync(file, JSON.stringify({ version: 2, accounts: {} }));
    expect(() => readWorkdayAccounts(file)).toThrow(WorkdayAccountsFileError);
    try { readWorkdayAccounts(file); } catch (error) { expect((error as Error).message).not.toContain("version"); }
  });

  it("keeps resend and reset times through writes and hold clears, and reads older files without them", () => {
    const file = join(scratch(), "workday-accounts.json");
    putWorkdayAccount(file, entry());
    expect(getWorkdayAccount(file, HOST)).toEqual(entry());
    expect(JSON.parse(readFileSync(file, "utf8")).accounts[HOST]).not.toHaveProperty("resentAt");
    const times = { resentAt: "2026-11-27T01:00:00.000Z", resetAt: "2026-11-27T02:00:00.000Z" };
    putWorkdayAccount(file, entry({ ...times, hold: { kind: "interrupted", reason: "Workday acme: no email.", at: "2026-11-27T02:00:00.000Z", attempts: 1 } }));
    expect(getWorkdayAccount(file, HOST)).toMatchObject(times);
    expect(clearWorkdayAccountHold(file, HOST, new Date("2026-11-27T03:00:00.000Z"))).toBe(true);
    expect(getWorkdayAccount(file, HOST)).toEqual(entry({ ...times, hold: null, updatedAt: "2026-11-27T03:00:00.000Z" }));
  });

  it("lists hosts without emails or passwords", () => {
    const file = join(scratch(), "workday-accounts.json");
    putWorkdayAccount(file, entry({ hold: { kind: "captcha", reason: "Workday acme: CAPTCHA.", at: "2026-11-19T12:00:00.000Z", attempts: 1 } }));
    const listed = listWorkdayAccounts(file);
    expect(listed).toEqual([{ host: HOST, account: "created", hold: "captcha", updatedAt: "2026-11-19T12:00:00.000Z" }]);
    expect(JSON.stringify(listed)).not.toContain("jordan@example.test");
    expect(JSON.stringify(listed)).not.toContain("Fixture-Pass-123!");
  });
});

describe("the Workday account gate", () => {
  const runtime = (file: string) => ({ runtime: { email: "jordan@example.test", file, mailbox: null } });
  const at = "2026-11-19T12:00:00.000Z";
  const later = (ms: number) => new Date(Date.parse(at) + ms);
  const hour = 3_600_000;

  it("passes the disabled reason through and holds on an email mismatch or an unreadable file", () => {
    const file = join(scratch(), "workday-accounts.json");
    expect(workdayAccountWait({ disabled: "Workday accounts: off." }, HOST, "jordan@example.test")).toBe("Workday accounts: off.");
    expect(workdayAccountWait(runtime(file), HOST, "someone@example.test")).toMatch(/does not match/);
    expect(workdayAccountWait(runtime(file), HOST, null)).toMatch(/does not match/);
    expect(workdayAccountWait(runtime(file), HOST, " Jordan@Example.TEST ")).toBeNull();
    writeFileSync(file, "garbage");
    expect(workdayAccountWait(runtime(file), HOST, "jordan@example.test")).toMatch(/cannot be read/);
  });

  it("keeps non-retryable holds until the candidate signs in", () => {
    const file = join(scratch(), "workday-accounts.json");
    putWorkdayAccount(file, entry({ account: "refused", hold: { kind: "exists", reason: "Workday acme: exists.", at, attempts: 1 } }));
    expect(workdayAccountWait(runtime(file), HOST, "jordan@example.test", later(100 * hour))).toBe("Workday acme: exists.");
  });

  it("retries email verification after 1 h, doubling per attempt, at most 24 h", () => {
    const file = join(scratch(), "workday-accounts.json");
    const hold = (attempts: number) => putWorkdayAccount(file, entry({ hold: { kind: "verify-email", reason: "Workday acme: mail not found.", at, attempts } }));
    hold(1);
    expect(workdayAccountWait(runtime(file), HOST, "jordan@example.test", later(hour - 1))).toBe("Workday acme: mail not found.");
    expect(workdayAccountWait(runtime(file), HOST, "jordan@example.test", later(hour))).toBeNull();
    hold(3);
    expect(workdayAccountWait(runtime(file), HOST, "jordan@example.test", later(4 * hour - 1))).not.toBeNull();
    expect(workdayAccountWait(runtime(file), HOST, "jordan@example.test", later(4 * hour))).toBeNull();
    hold(10);
    expect(workdayAccountWait(runtime(file), HOST, "jordan@example.test", later(24 * hour - 1))).not.toBeNull();
    expect(workdayAccountWait(runtime(file), HOST, "jordan@example.test", later(24 * hour))).toBeNull();
  });

  it("clears one host's hold, keeping the password and account state, and returns false for an unknown host", () => {
    const file = join(scratch(), "workday-accounts.json");
    putWorkdayAccount(file, entry({ account: "pending", hold: { kind: "locked", reason: "Workday acme: locked.", at, attempts: 1 } }));
    expect(workdayAccountWait(runtime(file), HOST, "jordan@example.test")).toBe("Workday acme: locked.");
    expect(clearWorkdayAccountHold(file, HOST, new Date("2026-11-25T03:00:00.000Z"))).toBe(true);
    expect(getWorkdayAccount(file, HOST)).toEqual(entry({ account: "pending", hold: null, updatedAt: "2026-11-25T03:00:00.000Z" }));
    expect(workdayAccountWait(runtime(file), HOST, "jordan@example.test")).toBeNull();
    expect(clearWorkdayAccountHold(file, "missing.wd1.myworkdayjobs.com")).toBe(false);
    expect(getWorkdayAccount(file, "missing.wd1.myworkdayjobs.com")).toBeNull();
    expect(Object.keys(readWorkdayAccounts(file))).toEqual([HOST]);
  });
});

describe("polling the mailbox", () => {
  const since = new Date();
  const target = { host: HOST, tenant: "acme", company: "Acme Rockets", since };
  const verification: MailMessage = {
    from: "Acme <acme@myworkday.com>", subject: "Verify your account", receivedAt: new Date(since.getTime() + 1_000), text: "",
    html: '<a href="https://acme.wd1.myworkdayjobs.com/External/activate/abc">Verify</a>'
  };
  const fakeMailbox = (batches: MailMessage[][], state: { closed: number; calls: number }): VerificationMailbox => ({
    messagesSince: async () => batches[Math.min(state.calls++, batches.length - 1)] ?? [],
    close: async () => { state.closed += 1; }
  });
  const noSleep = async () => undefined;

  it("finds the link on the third poll and closes the mailbox", async () => {
    const state = { closed: 0, calls: 0 };
    const result = await pollVerificationLink(async () => fakeMailbox([[], [], [verification]], state), target, { pollMs: 1, timeoutMs: 5_000, sleep: noSleep });
    expect(result).toEqual({ kind: "found", link: "https://acme.wd1.myworkdayjobs.com/External/activate/abc" });
    expect(state).toEqual({ closed: 1, calls: 3 });
  });

  it("gives up after the window and still closes the mailbox", async () => {
    const state = { closed: 0, calls: 0 };
    const result = await pollVerificationLink(async () => fakeMailbox([[]], state), target, { pollMs: 10, timeoutMs: 50 });
    expect(result).toEqual({ kind: "none" });
    expect(state.closed).toBe(1);
    expect(state.calls).toBeGreaterThanOrEqual(1);
  });

  it("finds a password-reset link on the second poll and closes the mailbox, and gives up after the window", async () => {
    const reset: MailMessage = {
      from: "Acme Rockets <acme@otp.workday.com>", subject: "Reset your password for your candidate account", receivedAt: new Date(since.getTime() + 1_000), text: "",
      html: "<p>Click the link below to reset your password.</p><p>https://acme.wd1.myworkdayjobs.com/External/passwordreset/abc</p>"
    };
    const found = { closed: 0, calls: 0 };
    expect(await pollPasswordResetLink(async () => fakeMailbox([[verification], [verification, reset]], found), target, { pollMs: 1, timeoutMs: 5_000, sleep: noSleep }))
      .toEqual({ kind: "found", link: "https://acme.wd1.myworkdayjobs.com/External/passwordreset/abc" });
    expect(found).toEqual({ closed: 1, calls: 2 });
    const none = { closed: 0, calls: 0 };
    expect(await pollPasswordResetLink(async () => fakeMailbox([[verification]], none), target, { pollMs: 10, timeoutMs: 50 })).toEqual({ kind: "none" });
    expect(none.closed).toBe(1);
  });

  it("reports a mailbox that cannot be opened or read with fixed messages", async () => {
    await expect(pollVerificationLink(async () => { throw new Error("secret server text"); }, target, { sleep: noSleep }))
      .rejects.toThrow(new MailboxUnavailable("the mailbox could not be opened"));
    const state = { closed: 0 };
    const broken: VerificationMailbox = { messagesSince: async () => { throw new Error("secret server text"); }, close: async () => { state.closed += 1; } };
    await expect(pollVerificationLink(async () => broken, target, { sleep: noSleep })).rejects.toThrow("the mailbox could not be read");
    expect(state.closed).toBe(1);
  });
});
