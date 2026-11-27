import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  findWorkdayPasswordResetLink,
  findWorkdayVerificationLink,
  generateWorkdayPassword,
  relevantWorkdayHeader,
  workdayAccountSettings,
  workdayAccountsFile,
  type MailMessage
} from "@internship-agent/agent";

import { gmailMailboxFactory, gmailSettings, imapVerificationMailbox, textParts, type ImapReader } from "../../packages/agent/src/gmail-mailbox";

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

  const textOnly = (url: string) =>
    `<table><tr><td><p>Please verify your candidate account.</p><p>${url}</p><p><a href="http://www.workday.com">Workday</a></p></td></tr></table>`;

  it("finds an activation link shown only as text in an HTML-only email (Workday's real email structure)", () => {
    const html = textOnly("https://acme.wd1.myworkdayjobs.com/External/activate/abc123/?redirect=%2FExternal%2Fjob%2FIntern_R1&amp;x=1");
    expect(findWorkdayVerificationLink([message({ from: "Acme Rockets <acme@otp.workday.com>", text: "", html })], target))
      .toEqual({ kind: "found", link: "https://acme.wd1.myworkdayjobs.com/External/activate/abc123/?redirect=%2FExternal%2Fjob%2FIntern_R1&x=1" });
  });

  it("drops a non-breaking space after a text link", () => {
    const html = "<p>Please verify your candidate account.</p><p>https://acme.wd1.myworkdayjobs.com/External/activate/abc123&nbsp;</p>";
    expect(findWorkdayVerificationLink([message({ html })], target))
      .toEqual({ kind: "found", link: "https://acme.wd1.myworkdayjobs.com/External/activate/abc123" });
  });

  it("counts the same link as an href and as visible text once", () => {
    const url = "https://acme.wd1.myworkdayjobs.com/External/activate/abc123";
    expect(findWorkdayVerificationLink([message({ html: `<p>Verify:</p><a href="${url}">Verify</a><p>${url}</p>` })], target))
      .toEqual({ kind: "found", link: url });
  });

  it("ignores another tenant's text link and URLs inside other attributes", () => {
    expect(findWorkdayVerificationLink([message({ html: textOnly("https://other.wd1.myworkdayjobs.com/External/activate/x") })], target).kind).toBe("none");
    const pixel = '<p>Please verify your candidate account.</p><img src="https://acme.wd1.myworkdayjobs.com/External/activate/pixel.png">';
    expect(findWorkdayVerificationLink([message({ html: pixel })], target).kind).toBe("none");
  });

  it("prefers the href when its displayed URL differs, so the message is not ambiguous", () => {
    const html = '<a href="https://acme.wd1.myworkdayjobs.com/External/activate/abc123?x=1">https://acme.wd1.myworkdayjobs.com/External/activate/abc123</a>';
    expect(findWorkdayVerificationLink([message({ html })], target))
      .toEqual({ kind: "found", link: "https://acme.wd1.myworkdayjobs.com/External/activate/abc123?x=1" });
  });

  it("skips links the agent already found or opened (exclude), so a resent email's new link is picked", () => {
    const older = message({ html: textOnly("https://acme.wd1.myworkdayjobs.com/External/activate/old") });
    const newer = message({ html: textOnly("https://acme.wd1.myworkdayjobs.com/External/activate/new") });
    const exclude = ["https://acme.wd1.myworkdayjobs.com/External/activate/old"];
    expect(findWorkdayVerificationLink([older, newer], { ...target, exclude }))
      .toEqual({ kind: "found", link: "https://acme.wd1.myworkdayjobs.com/External/activate/new" });
    expect(findWorkdayVerificationLink([older], { ...target, exclude }).kind).toBe("none");
    expect(findWorkdayVerificationLink([older, newer], target)).toEqual({ kind: "ambiguous", count: 2 });
  });
});

describe("Workday password-reset links", () => {
  const since = new Date("2026-11-27T12:00:00.000Z");
  const target = { host: "acme.wd1.myworkdayjobs.com", tenant: "acme", company: "Acme Rockets", since };
  const resetUrl = "https://acme.wd1.myworkdayjobs.com/External/passwordreset/abc123";
  // Shaped like Workday's captured HTML-only verification email (the link only as text); the sender, subject, and
  // two-hour expiry are from public sources (2025-11-06); the link's path is modelled.
  const resetHtml = (url: string) =>
    `<table><tr><td><p>Click the link below to reset your password. The link expires in 2 hours.</p><p>${url}</p><p><a href="http://www.workday.com">Workday</a></p></td></tr></table>`;
  const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
    from: "Acme Rockets <acme@otp.workday.com>", subject: "Reset your password for your candidate account",
    receivedAt: new Date(since.getTime() + 30_000), text: "", html: resetHtml(resetUrl), ...overrides
  });
  const find = (overrides: Partial<MailMessage> = {}) => findWorkdayPasswordResetLink([message(overrides)], target);

  it("finds the reset link shown only as text in an HTML-only email, and an href", () => {
    expect(find()).toEqual({ kind: "found", link: resetUrl });
    expect(find({ html: `<p>Reset your password.</p><a href="${resetUrl}?a=1&amp;b=2">Reset</a>` }))
      .toEqual({ kind: "found", link: `${resetUrl}?a=1&b=2` });
  });

  it("accepts only https links on the tenant's own host whose path names a reset and no activation step", () => {
    expect(find({ html: resetHtml("http://acme.wd1.myworkdayjobs.com/External/passwordreset/x") }).kind).toBe("none");
    expect(find({ html: resetHtml("https://other.wd1.myworkdayjobs.com/External/passwordreset/x") }).kind).toBe("none");
    expect(find({ html: resetHtml("https://www.myworkday.com/acme/passwordreset/x") }).kind).toBe("none");
    expect(find({ html: resetHtml("https://user@acme.wd1.myworkdayjobs.com/External/passwordreset/x") }).kind).toBe("none");
    expect(find({ html: resetHtml("https://acme.wd1.myworkdayjobs.com/External/unsubscribe?reset=1") }).kind).toBe("none");
    expect(find({ html: resetHtml("https://acme.wd1.myworkdayjobs.com/External/activate/x?password=1") }).kind).toBe("none");
    expect(find({ html: resetHtml("https://acme.wd1.myworkdayjobs.com/External") }).kind).toBe("none");
  });

  it("ignores mail older than the request (two minutes of skew), without a reset phrase, or from an unrelated sender", () => {
    expect(find({ receivedAt: new Date(since.getTime() - 121_000) }).kind).toBe("none");
    expect(find({ receivedAt: new Date(since.getTime() - 60_000) }).kind).toBe("found");
    expect(find({ subject: "Your candidate account", html: `<p>Hello.</p><p>${resetUrl}</p>` }).kind).toBe("none");
    expect(find({ from: "Deals <deals@shop.example>", subject: "Reset your password now", html: "<p>Reset your password: https://shop.example/passwordreset/x</p>" }).kind).toBe("none");
  });

  it("calls two distinct reset links ambiguous", () => {
    const second = message({ html: resetHtml("https://acme.wd1.myworkdayjobs.com/External/passwordreset/def456") });
    expect(findWorkdayPasswordResetLink([message(), second], target)).toEqual({ kind: "ambiguous", count: 2 });
  });

  it("keeps reset and verification mail apart", () => {
    expect(findWorkdayVerificationLink([message()], target).kind).toBe("none");
    const verification = message({
      subject: "Verify your candidate account",
      html: "<p>Please verify your candidate account.</p><p>https://acme.wd1.myworkdayjobs.com/External/activate/abc123</p>"
    });
    expect(findWorkdayPasswordResetLink([verification], target).kind).toBe("none");
  });
});

type FakeMail = { uid: number; at: Date; name: string; address: string; subject: string; html: string };

/** A fake IMAP client over in-memory messages; it records lock options and body downloads. */
function fakeImap(messages: FakeMail[]) {
  const locks: unknown[] = [];
  const downloads: number[] = [];
  const fake = {
    async getMailboxLock(_path: string, options?: unknown) {
      locks.push(options);
      return { path: "INBOX", release() {} };
    },
    async search(query: { since: Date }) {
      return messages.filter((entry) => entry.at.getTime() >= query.since.getTime()).map((entry) => entry.uid);
    },
    async *fetch(range: string) {
      const wanted = new Set(range.split(",").map(Number));
      for (const entry of messages) {
        if (!wanted.has(entry.uid)) continue;
        yield { uid: entry.uid, internalDate: entry.at, envelope: { from: [{ name: entry.name, address: entry.address }], subject: entry.subject }, bodyStructure: { type: "text/html" } };
      }
    },
    async download(uid: string) {
      downloads.push(Number(uid));
      const entry = messages.find((candidate) => candidate.uid === Number(uid))!;
      return { meta: {}, content: Readable.from([Buffer.from(entry.html)]) };
    },
    async logout() {},
    close() {}
  };
  return { client: fake as unknown as ImapReader, locks, downloads };
}

describe("Gmail verification reader", () => {
  const since = new Date("2026-11-19T12:00:00.000Z");
  const target = { host: "acme.wd1.myworkdayjobs.com", tenant: "acme", company: "Acme Rockets", since };
  const verifyHtml = (token: string) =>
    `<table><tr><td><p>Please verify your candidate account.</p><p>https://acme.wd1.myworkdayjobs.com/External/activate/${token}</p><p><a href="http://www.workday.com">Workday</a></p></td></tr></table>`;
  const verification = (uid: number, at: Date): FakeMail => ({
    uid, at, name: "Acme Rockets", address: "acme@otp.workday.com", subject: "Verify your candidate account", html: verifyHtml(`token${uid}`)
  });

  it("still reads an older verification email behind 120 newer unrelated messages, read-only", async () => {
    const mail: FakeMail[] = [verification(1, new Date(since.getTime() + 30_000))];
    for (let uid = 2; uid <= 121; uid += 1) {
      mail.push({ uid, at: new Date(since.getTime() + 3_600_000 + (uid - 2) * 60_000), name: "Shop", address: "news@shop.example", subject: "Weekly deals", html: "<p>Deals</p>" });
    }
    const { client, locks, downloads } = fakeImap(mail);
    const mailbox = imapVerificationMailbox(client);
    const messages = await mailbox.messagesSince(since, relevantWorkdayHeader(target));
    await mailbox.close();
    expect(messages).toHaveLength(1);
    expect(findWorkdayVerificationLink(messages, target)).toEqual({ kind: "found", link: "https://acme.wd1.myworkdayjobs.com/External/activate/token1" });
    expect(locks).toEqual([{ readOnly: true }]);
    expect(downloads).toEqual([1]);
  });

  it("reads bodies of at most the 20 newest relevant messages", async () => {
    const mail = Array.from({ length: 25 }, (_, index) => verification(index + 1, new Date(since.getTime() + 30_000 + index * 60_000)));
    const { client, downloads } = fakeImap(mail);
    const messages = await imapVerificationMailbox(client).messagesSince(since, relevantWorkdayHeader(target));
    expect(messages).toHaveLength(20);
    expect(downloads).toEqual(Array.from({ length: 20 }, (_, index) => index + 6));
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
