import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findIcimsVerificationLink,
  icimsAccountSettings,
  icimsAccountsFile,
  icimsAccountWait,
  putIcimsAccount,
  type IcimsAccountEntry,
  type MailMessage,
  type ResolvedIcimsAccounts
} from "@internship-agent/agent";

// Every env here is an explicit object: nothing reads process.env or the real .env. Hosts and emails are fictional.
const on = { INTERNSHIP_AGENT_ICIMS_ACCOUNTS: "1", INTERNSHIP_AGENT_ACCOUNT_EMAIL: "Jordan@Example.test", INTERNSHIP_AGENT_AUTO_APPLY: "1" };
const HOST = "careers-fixture.icims.com";
const EMAIL = "jordan@example.test";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function accountsFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-icims-account-"));
  directories.push(directory);
  return join(directory, "config", "icims-accounts.json");
}

describe("iCIMS account settings", () => {
  it("are off unless the flag, a valid account email, auto-apply, and the AI flow are all on", () => {
    expect(icimsAccountSettings({})).toBeNull();
    expect(icimsAccountSettings({ ...on, INTERNSHIP_AGENT_ICIMS_ACCOUNTS: "" })).toBeNull();
    expect(icimsAccountSettings({ ...on, INTERNSHIP_AGENT_ICIMS_ACCOUNTS: "yes" })).toBeNull();
    expect(icimsAccountSettings({ INTERNSHIP_AGENT_ICIMS_ACCOUNTS: "1", INTERNSHIP_AGENT_AUTO_APPLY: "1" })).toBeNull();
    expect(icimsAccountSettings({ ...on, INTERNSHIP_AGENT_ACCOUNT_EMAIL: "not an email" })).toBeNull();
    expect(icimsAccountSettings({ ...on, INTERNSHIP_AGENT_AUTO_APPLY: "0" })).toBeNull();
    expect(icimsAccountSettings({ ...on, INTERNSHIP_AGENT_MANUAL_ONLY: "1" })).toBeNull();
    expect(icimsAccountSettings(on)).toEqual({ email: EMAIL, file: null, mailbox: null });
  });

  it("prefer the shared account email and fall back to the Workday one", () => {
    expect(icimsAccountSettings({ ...on, INTERNSHIP_AGENT_WORKDAY_ACCOUNT_EMAIL: "other@example.test" })?.email).toBe(EMAIL);
    const fallback = { INTERNSHIP_AGENT_ICIMS_ACCOUNTS: "1", INTERNSHIP_AGENT_AUTO_APPLY: "1", INTERNSHIP_AGENT_WORKDAY_ACCOUNT_EMAIL: "Casey@Example.test" };
    expect(icimsAccountSettings(fallback)?.email).toBe("casey@example.test");
    expect(icimsAccountSettings({ ...on, INTERNSHIP_AGENT_ICIMS_ACCOUNTS_FILE: "/tmp/xdg-test/icims.json" })?.file).toBe("/tmp/xdg-test/icims.json");
  });

  it("place the accounts file outside the data directory, or nowhere when a data directory is set", () => {
    expect(icimsAccountsFile("real", { INTERNSHIP_AGENT_ICIMS_ACCOUNTS_FILE: "/tmp/xdg-test/override.json", INTERNSHIP_AGENT_DATA_DIR: "/tmp/data" }))
      .toBe("/tmp/xdg-test/override.json");
    expect(icimsAccountsFile("real", { INTERNSHIP_AGENT_DATA_DIR: "/tmp/data" })).toBeNull();
    expect(icimsAccountsFile("real", { XDG_CONFIG_HOME: "/tmp/xdg-test" })).toBe("/tmp/xdg-test/internship-agent/real/icims-accounts.json");
    expect(icimsAccountsFile("demo", { XDG_CONFIG_HOME: "/tmp/xdg-test" })).toBe("/tmp/xdg-test/internship-agent/demo/icims-accounts.json");
  });
});

describe("iCIMS verification links", () => {
  const since = new Date("2026-11-20T12:00:00.000Z");
  const target = { host: HOST, company: "Fixture Robotics", since };
  const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
    from: "Fixture Robotics Careers <no-reply@icims.com>",
    subject: "Verify your email address",
    receivedAt: new Date("2026-11-20T12:01:00.000Z"),
    text: "",
    html: "",
    ...overrides
  });

  it("accepts one https activation link on the tenant host or another iCIMS host", () => {
    expect(findIcimsVerificationLink([message({ text: `Verify here: https://${HOST}/jobs/9001/intern/verify?token=abc.` })], target))
      .toEqual({ kind: "found", link: `https://${HOST}/jobs/9001/intern/verify?token=abc` });
    expect(findIcimsVerificationLink([message({ html: '<a href="https://login.icims.com/activate?t=1&amp;u=2">Activate</a>' })], target))
      .toEqual({ kind: "found", link: "https://login.icims.com/activate?t=1&u=2" });
  });

  it("rejects http, other sites, userinfo, unsubscribe links, and paths without an activation step", () => {
    for (const link of [
      `http://${HOST}/verify?token=abc`,
      "https://phish.example.test/verify?token=abc",
      `https://user:pass@${HOST}/verify?token=abc`,
      `https://${HOST}/verify/unsubscribe`,
      `https://${HOST}/jobs/9001/job`,
      "https://icims.com.example.test/verify"
    ]) {
      expect(findIcimsVerificationLink([message({ text: `Verify: ${link}` })], target)).toEqual({ kind: "none" });
    }
  });

  it("reports several links as ambiguous and skips mail older than the account (beyond clock skew)", () => {
    const two = [
      message({ text: `Verify: https://${HOST}/verify?token=one` }),
      message({ text: `Verify: https://${HOST}/verify?token=two` })
    ];
    expect(findIcimsVerificationLink(two, target)).toEqual({ kind: "ambiguous", count: 2 });
    expect(findIcimsVerificationLink([message({ receivedAt: new Date("2026-11-20T11:59:00.000Z"), text: `Verify: https://${HOST}/verify?token=a` })], target).kind).toBe("found");
    expect(findIcimsVerificationLink([message({ receivedAt: new Date("2026-11-20T11:50:00.000Z"), text: `Verify: https://${HOST}/verify?token=a` })], target)).toEqual({ kind: "none" });
  });

  it("reads mail from the company's own sender and needs an activation path", () => {
    const company = message({ from: "careers@fixturerobotics.example", subject: "Fixture Robotics: confirm your email", text: `Confirm: https://${HOST}/confirm?token=a` });
    expect(findIcimsVerificationLink([company], target).kind).toBe("found");
    expect(findIcimsVerificationLink([message({ subject: "Your application", text: `See https://${HOST}/verify?token=a` })], target).kind).toBe("found");
    expect(findIcimsVerificationLink([message({ subject: "Your application", text: `See https://${HOST}/jobs?token=a` })], target)).toEqual({ kind: "none" });
  });
});

describe("the iCIMS hold gate", () => {
  const now = new Date("2026-11-20T12:00:00.000Z");
  const entry = (hold: IcimsAccountEntry["hold"]): IcimsAccountEntry => ({
    host: HOST, email: EMAIL, password: "Saved-Pass-1234!", account: "created", hold, createdAt: now.toISOString(), updatedAt: now.toISOString()
  });
  const resolved = (file: string): ResolvedIcimsAccounts => ({ runtime: { email: EMAIL, file, mailbox: null } });

  it("lets a host with no entry or no hold run, and refuses a mismatched email or a disabled setup", () => {
    const file = accountsFile();
    expect(icimsAccountWait(resolved(file), HOST, EMAIL, now)).toBeNull();
    putIcimsAccount(file, entry(null));
    expect(icimsAccountWait(resolved(file), HOST, "JORDAN@example.test", now)).toBeNull();
    expect(icimsAccountWait(resolved(file), HOST, "someone@example.test", now)).toMatch(/does not match the account email/);
    expect(icimsAccountWait({ disabled: "iCIMS accounts: off." }, HOST, EMAIL, now)).toBe("iCIMS accounts: off.");
  });

  it("retries a verification hold after its backoff", () => {
    const file = accountsFile();
    putIcimsAccount(file, entry({ kind: "verify-email", reason: "verify", at: now.toISOString(), attempts: 2 }));
    expect(icimsAccountWait(resolved(file), HOST, EMAIL, new Date(now.getTime() + 3_600_000))).toBe("verify");
    expect(icimsAccountWait(resolved(file), HOST, EMAIL, new Date(now.getTime() + 7_200_000))).toBeNull();
  });

  it("releases a consent-setting hold only once the data-consent setting is on, and keeps every other hold", () => {
    const file = accountsFile();
    putIcimsAccount(file, entry({ kind: "consent-setting", reason: "needs the setting", at: now.toISOString(), attempts: 1 }));
    expect(icimsAccountWait(resolved(file), HOST, EMAIL, now)).toBe("needs the setting");
    expect(icimsAccountWait(resolved(file), HOST, EMAIL, now, true)).toBeNull();
    for (const kind of ["captcha", "exists-no-password", "wrong-password", "consent-unknown", "profile", "unexpected"] as const) {
      putIcimsAccount(file, entry({ kind, reason: `held: ${kind}`, at: now.toISOString(), attempts: 1 }));
      expect(icimsAccountWait(resolved(file), HOST, EMAIL, new Date(now.getTime() + 86_400_000 * 3), true)).toBe(`held: ${kind}`);
    }
  });
});
