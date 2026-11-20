import { describe, expect, it } from "vitest";

import {
  findWorkdayVerificationLink,
  generateWorkdayPassword,
  relevantWorkdayHeader,
  workdayAccountSettings,
  workdayAccountsFile,
  type MailMessage
} from "@internship-agent/agent";

import { gmailMailboxFactory, gmailSettings, textParts } from "../../packages/agent/src/gmail-mailbox";

// Every env here is an explicit object: nothing reads process.env or the real .env.
const on = { INTERNSHIP_AGENT_WORKDAY_ACCOUNT_EMAIL: "Jordan@Example.test", INTERNSHIP_AGENT_AUTO_APPLY: "1" };

describe("Workday account passwords", () => {
  it("are 16 characters with every class, only allowed characters, and never repeat", () => {
    const seen = new Set<string>();
    for (let sample = 0; sample < 500; sample += 1) {
      const password = generateWorkdayPassword();
      expect(password).toHaveLength(16);
      expect(password).toMatch(/[A-HJ-NP-Z]/);
      expect(password).toMatch(/[a-km-z]/);
      expect(password).toMatch(/[2-9]/);
      expect(password).toMatch(/[!@#$%^&*]/);
      expect(password).toMatch(/^[A-HJ-NP-Za-km-z2-9!@#$%^&*]+$/);
      seen.add(password);
    }
    expect(seen.size).toBe(500);
  });
});

describe("Workday account settings", () => {
  it("are off unless a valid email, auto-apply, and the AI flow are all on", () => {
    expect(workdayAccountSettings({})).toBeNull();
    expect(workdayAccountSettings({ INTERNSHIP_AGENT_AUTO_APPLY: "1" })).toBeNull();
    expect(workdayAccountSettings({ ...on, INTERNSHIP_AGENT_WORKDAY_ACCOUNT_EMAIL: "not an email" })).toBeNull();
    expect(workdayAccountSettings({ ...on, INTERNSHIP_AGENT_AUTO_APPLY: "0" })).toBeNull();
    expect(workdayAccountSettings({ ...on, INTERNSHIP_AGENT_MANUAL_ONLY: "1" })).toBeNull();
    expect(workdayAccountSettings(on)).toEqual({ email: "jordan@example.test", file: null, mailbox: null });
  });

  it("resolve a file override and build a mailbox only with both Gmail variables", () => {
    const withFile = workdayAccountSettings({ ...on, INTERNSHIP_AGENT_WORKDAY_ACCOUNTS_FILE: "/tmp/xdg-test/accounts.json" });
    expect(withFile?.file).toBe("/tmp/xdg-test/accounts.json");
    expect(workdayAccountSettings({ ...on, INTERNSHIP_AGENT_GMAIL_ADDRESS: "jordan@example.test" })?.mailbox).toBeNull();
    expect(workdayAccountSettings({ ...on, INTERNSHIP_AGENT_GMAIL_APP_PASSWORD: "abcd efgh" })?.mailbox).toBeNull();
    // A factory is only built (never called), so no mail server is contacted.
    expect(typeof workdayAccountSettings({ ...on, INTERNSHIP_AGENT_GMAIL_ADDRESS: "jordan@example.test", INTERNSHIP_AGENT_GMAIL_APP_PASSWORD: "abcd efgh" })?.mailbox).toBe("function");
  });

  it("place the accounts file outside the data directory, or nowhere when a data directory is set", () => {
    expect(workdayAccountsFile("real", { INTERNSHIP_AGENT_WORKDAY_ACCOUNTS_FILE: "/tmp/xdg-test/override.json", INTERNSHIP_AGENT_DATA_DIR: "/tmp/data" }))
      .toBe("/tmp/xdg-test/override.json");
    expect(workdayAccountsFile("real", { INTERNSHIP_AGENT_DATA_DIR: "/tmp/data" })).toBeNull();
    expect(workdayAccountsFile("real", { XDG_CONFIG_HOME: "/tmp/xdg-test" })).toBe("/tmp/xdg-test/internship-agent/real/workday-accounts.json");
    expect(workdayAccountsFile("demo", { XDG_CONFIG_HOME: "/tmp/xdg-test" })).toBe("/tmp/xdg-test/internship-agent/demo/workday-accounts.json");
  });

  it("read the Gmail app password without its spaces and need both variables", () => {
    expect(gmailSettings({ INTERNSHIP_AGENT_GMAIL_ADDRESS: "jordan@example.test", INTERNSHIP_AGENT_GMAIL_APP_PASSWORD: " abcd efgh ijkl mnop " }))
      .toEqual({ address: "jordan@example.test", appPassword: "abcdefghijklmnop" });
    expect(gmailSettings({ INTERNSHIP_AGENT_GMAIL_ADDRESS: "jordan@example.test" })).toBeNull();
    expect(gmailSettings({ INTERNSHIP_AGENT_GMAIL_APP_PASSWORD: "abcd" })).toBeNull();
    expect(gmailSettings({ INTERNSHIP_AGENT_GMAIL_ADDRESS: "nope", INTERNSHIP_AGENT_GMAIL_APP_PASSWORD: "abcd" })).toBeNull();
    expect(gmailMailboxFactory({})).toBeNull();
  });
});

describe("Workday verification links", () => {
  const since = new Date("2026-11-19T12:00:00.000Z");
  const target = { host: "acme.wd1.myworkdayjobs.com", tenant: "acme", company: "Acme Rockets", since };
  const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
    from: "Acme <acme@myworkday.com>", subject: "Verify your candidate account", receivedAt: new Date(since.getTime() + 30_000), text: "", html: "", ...overrides
  });
  const link = (url: string, overrides: Partial<MailMessage> = {}) => findWorkdayVerificationLink([message({ html: `<a href="${url}">Verify</a>`, ...overrides })], target);

  it("finds the activation href with entities decoded and ignores the careers link", () => {
    const html = '<a href="https://acme.wd1.myworkdayjobs.com/External/activate/abc123?a=1&amp;b=2">Verify</a> <a href="https://acme.wd1.myworkdayjobs.com/External">Careers</a>';
    expect(findWorkdayVerificationLink([message({ html })], target))
      .toEqual({ kind: "found", link: "https://acme.wd1.myworkdayjobs.com/External/activate/abc123?a=1&b=2" });
  });

  it("rejects http, other hosts, look-alike Workday domains, userinfo, unsubscribe links, and old mail", () => {
    expect(link("http://acme.wd1.myworkdayjobs.com/External/activate/x").kind).toBe("none");
    expect(link("https://evil.example/activate/x").kind).toBe("none");
    expect(link("https://other.wd1.myworkdayjobs.com/External/activate/x").kind).toBe("none");
    expect(link("https://evilworkday.com/activate/x").kind).toBe("none");
    expect(link("https://notmyworkday.com/verify/x").kind).toBe("none");
    expect(link("https://user@acme.wd1.myworkdayjobs.com/External/activate/x").kind).toBe("none");
    expect(link("https://acme.wd1.myworkdayjobs.com/External/unsubscribe?verify=1").kind).toBe("none");
    expect(link("https://acme.wd1.myworkdayjobs.com/External/activate/x", { receivedAt: new Date(since.getTime() - 121_000) }).kind).toBe("none");
    expect(link("https://acme.wd1.myworkdayjobs.com/External/activate/x", { receivedAt: new Date(since.getTime() - 60_000) }).kind).toBe("found");
  });

  it("reads bodies only of mail whose header mentions Workday, the tenant, or the company, and ignores unrelated mail", () => {
    const relevant = relevantWorkdayHeader(target);
    expect(relevant({ from: "Shop <news@shop.example>", subject: "Confirm your order" })).toBe(false);
    expect(relevant({ from: "Careers <careers@acme.example>", subject: "Welcome" })).toBe(true);
    expect(relevant({ from: "Talent <talent@rockets.example>", subject: "Your Acme Rockets account" })).toBe(true);
    expect(relevant({ from: "No Reply <noreply@myworkday.com>", subject: "Hello" })).toBe(true);
    expect(relevantWorkdayHeader({ ...target, company: "Ac" })({ from: "x <x@ac.example>", subject: "Ac news" })).toBe(false);
    expect(link("https://shop.example/confirm/x", { from: "Shop <news@shop.example>", subject: "Confirm your order" }).kind).toBe("none");
  });

  it("accepts Workday-domain activation links from the tenant's mail", () => {
    expect(link("https://fixture.myworkday.com/activate/x")).toEqual({ kind: "found", link: "https://fixture.myworkday.com/activate/x" });
    expect(link("https://www.workday.com/verify/x").kind).toBe("found");
  });

  it("calls two distinct tokens ambiguous and counts the same link in text and html once", () => {
    const two = findWorkdayVerificationLink([
      message({ html: '<a href="https://acme.wd1.myworkdayjobs.com/External/activate/one">Verify</a>' }),
      message({ html: '<a href="https://acme.wd1.myworkdayjobs.com/External/activate/two">Verify</a>' })
    ], target);
    expect(two).toEqual({ kind: "ambiguous", count: 2 });
    const once = findWorkdayVerificationLink([message({
      html: '<a href="https://acme.wd1.myworkdayjobs.com/External/activate/one">Verify</a>',
      text: "Verify here: https://acme.wd1.myworkdayjobs.com/External/activate/one."
    })], target);
    expect(once).toEqual({ kind: "found", link: "https://acme.wd1.myworkdayjobs.com/External/activate/one" });
  });
});

describe("mail body parts", () => {
  it("picks the first inline text and html parts and skips attachments", () => {
    expect(textParts({ type: "multipart/alternative", childNodes: [{ part: "1", type: "text/plain" }, { part: "2", type: "text/html" }] }))
      .toEqual({ plain: "1", html: "2" });
    expect(textParts({ type: "multipart/mixed", childNodes: [
      { part: "1", type: "text/plain", disposition: "attachment" },
      { type: "multipart/alternative", childNodes: [{ part: "2.1", type: "text/plain" }, { part: "2.2", type: "text/html" }] },
      { part: "3", type: "text/html" }
    ] })).toEqual({ plain: "2.1", html: "2.2" });
    expect(textParts({ type: "text/html" })).toEqual({ plain: null, html: "1" });
    expect(textParts({ type: "text/plain", part: "1" })).toEqual({ plain: "1", html: null });
  });
});
