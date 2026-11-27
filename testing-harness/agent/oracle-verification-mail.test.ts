/**
 * Oracle Cloud HCM Candidate Experience's emailed one-time code, from a fake
 * mailbox only (no network, no real mail): Oracle's senders (dot-bounded
 * oracle.com / oraclecloud.com), the company in From or Subject, or the
 * tenant label in From; other application sites' mail never counts; six-digit
 * codes next to a "code", "PIN", or "passcode" anchor, in text or HTML; mail
 * from 30 s before the Next click on; the company's own domain (its name
 * joined or its initials, or the careers URL's root; Track 63, shaped from
 * a national laboratory's "STAFFING" mail headers of 2026-11-27, with
 * fictional domains); exactly one distinct code or a stop;
 * bounded polling with mailbox failures as fixed phrases; and the code never
 * logged. Oracle's mail was never seen (its sender and template are tenant
 * settings), so the wording here is derived; every code, company, and host is
 * fictional.
 */
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";

import {
  companyMailDomains,
  companyMailLabels,
  findOracleVerificationCode,
  MailboxUnavailable,
  oracleCodesIn,
  oracleMailSender,
  pollOracleVerificationCode,
  relevantOracleCodeHeader,
  type MailMessage,
  type VerificationMailbox,
  type VerificationMailboxFactory
} from "@internship-agent/agent";

const CODE = "482913";
const OTHER_CODE = "705162";
const ALL_CODES = [CODE, OTHER_CODE];
const COMPANY = "Fixture Robotics";
const HOST = "fixture.fa.ocs.oraclecloud.com";
const TARGET = { host: HOST, company: COMPANY };
const SINCE = new Date("2026-11-24T10:08:00.000Z");

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    from: "Fixture Robotics Careers <fixture.fa.sender@workflow.mail.us2.cloud.oracle.com>",
    subject: "Confirm your identity",
    receivedAt: new Date(SINCE.getTime() + 60_000),
    text: `Your verification code is ${CODE}. Enter it on the career site to continue your application.`,
    html: "",
    ...overrides
  };
}

/** A mailbox that serves `reads[n]` on the n-th read (the last one repeats) and records its use. */
function fakeMailbox(reads: MailMessage[][], options: { readError?: Error } = {}) {
  const calls = { opened: 0, reads: 0, closed: 0 };
  const factory: VerificationMailboxFactory = async () => {
    calls.opened += 1;
    const mailbox: VerificationMailbox = {
      messagesSince: async (_since, relevant) => {
        calls.reads += 1;
        if (options.readError) throw options.readError;
        const batch = reads[Math.min(calls.reads - 1, reads.length - 1)] ?? [];
        return batch.filter((entry) => relevant({ from: entry.from, subject: entry.subject }));
      },
      close: async () => { calls.closed += 1; }
    };
    return mailbox;
  };
  return { factory, calls };
}

const noSleep = async () => undefined;
const spies: MockInstance[] = [];

beforeAll(() => {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) spies.push(vi.spyOn(console, level).mockImplementation(() => undefined));
});

afterAll(() => {
  for (const code of ALL_CODES) {
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(code);
    }
  }
  for (const spy of spies) spy.mockRestore();
});

describe("Oracle code senders", () => {
  it("accepts Oracle's mail domains and their subdomains, dot-bounded", () => {
    expect(oracleMailSender("Fixture Robotics <fixture.fa.sender@workflow.mail.us2.cloud.oracle.com>")).toBe(true);
    expect(oracleMailSender("no-reply@oracle.com")).toBe(true);
    expect(oracleMailSender("Careers <no-reply@fixture.fa.ocs.oraclecloud.com>")).toBe(true);
    expect(oracleMailSender("someone@notoracle.com")).toBe(false);
    expect(oracleMailSender("someone@oracle.com.example")).toBe(false);
    expect(oracleMailSender("someone@notoraclecloud.com")).toBe(false);
  });

  it("counts Oracle's mail, the company in From or Subject, or the tenant label in From", () => {
    const relevant = relevantOracleCodeHeader(TARGET);
    expect(relevant({ from: "no-reply@oracle.com", subject: "Anything" })).toBe(true);
    expect(relevant({ from: "Fixture Robotics Careers <careers@fixturerobotics.example>", subject: "Your code" })).toBe(true);
    expect(relevant({ from: "Careers <careers@mailer.example>", subject: "Your Fixture Robotics verification code" })).toBe(true);
    expect(relevant({ from: "Careers <careers@mailer.example>", subject: "Your code" })).toBe(false);
    // The tenant label (the host's first label) counts in From only, and only when at least 4 characters.
    const tenant = relevantOracleCodeHeader({ host: "elhx.fa.us8.oraclecloud.com", company: "Nobody Else" });
    expect(tenant({ from: "elhx careers <careers@mailer.example>", subject: "Your code" })).toBe(true);
    expect(tenant({ from: "careers@mailer.example", subject: "elhx code" })).toBe(false);
    const short = relevantOracleCodeHeader({ host: "abc.fa.us8.oraclecloud.com", company: "Nobody Else" });
    expect(short({ from: "abc careers <careers@mailer.example>", subject: "Your code" })).toBe(false);
  });

  it("never counts Greenhouse, Workday, or iCIMS mail, even when it names the company", () => {
    const relevant = relevantOracleCodeHeader(TARGET);
    for (const from of [
      "Greenhouse <no-reply@us.greenhouse-mail.io>",
      "Fixture Robotics <no-reply@greenhouse.io>",
      "Fixture Robotics <fixture@myworkday.com>",
      "Fixture Robotics <no-reply@workday.com>",
      "Fixture Robotics <x@myworkdayjobs.com>",
      "Fixture Robotics via iCIMS <no-reply@icims.com>"
    ]) {
      expect(relevant({ from, subject: `Your ${COMPANY} verification code` })).toBe(false);
    }
  });
});

describe("the company's own domain (Track 63)", () => {
  // A host whose tenant label appears in no address below, so only the company rules decide.
  const host = "zq7k.fa.us8.oraclecloud.com";

  it("counts mail at the company's initials or joined name, never a single word or a look-alike", () => {
    const laboratory = relevantOracleCodeHeader({ host, company: "Fixture National Laboratory" });
    expect(laboratory({ from: "STAFFING <staffing@fnl.example>", subject: "Confirm your identity" })).toBe(true);
    expect(laboratory({ from: "x@mail.fnl.example", subject: "Confirm your identity" })).toBe(true);
    expect(laboratory({ from: "x@fixturenationallaboratory.example", subject: "Confirm your identity" })).toBe(true);
    expect(laboratory({ from: "x@notfnl.example", subject: "Confirm your identity" })).toBe(false);
    expect(laboratory({ from: "x@fnl.example.attacker.test", subject: "Confirm your identity" })).toBe(false);
    expect(laboratory({ from: "x@national.example", subject: "Confirm your identity" })).toBe(false);
    expect(laboratory({ from: "x@laboratory.example", subject: "Confirm your identity" })).toBe(false);

    const robotics = relevantOracleCodeHeader({ host, company: COMPANY });
    expect(robotics({ from: "Talent <talent@fixturerobotics.example>", subject: "Confirm your identity" })).toBe(true);
    // Two words make no initials; single words never count.
    expect(robotics({ from: "x@fr.example", subject: "Confirm your identity" })).toBe(false);
    expect(robotics({ from: "x@fixture.example", subject: "Confirm your identity" })).toBe(false);
    expect(robotics({ from: "x@robotics.example", subject: "Confirm your identity" })).toBe(false);
    expect(relevantOracleCodeHeader({ host, company: "Fixture Robotics Inc." })({ from: "talent@fixturerobotics.example", subject: "Confirm your identity" })).toBe(true);
  });

  it("derives labels from the name only", () => {
    expect(companyMailLabels("Fixture National Laboratory")).toEqual(["fixturenationallaboratory", "fnl"]);
    expect(companyMailLabels("Fixture Robotics Inc.")).toEqual(["fixturerobotics"]);
    expect(companyMailLabels("The Bureau of Fixture Science")).toEqual(["bureauoffixturescience", "bfs"]);
    expect(companyMailLabels("Ab")).toEqual([]);
  });

  it("takes the careers URL's registrable domain, never an application site's", () => {
    expect(companyMailDomains([
      "https://careers.fixture-group.example/jobs", "https://boards.greenhouse.io/fixture", "https://fixture.fa.us2.oraclecloud.com/x", null
    ])).toEqual(["fixture-group.example"]);
    expect(companyMailDomains(["https://jobs.fixture.co.uk/careers", "ftp://files.fixture-group.example/", "not a url"])).toEqual(["fixture.co.uk"]);
    const relevant = relevantOracleCodeHeader({ host, company: "Nobody Else", companyDomains: ["fixture-group.example"] });
    expect(relevant({ from: "x@mail.fixture-group.example", subject: "Confirm your identity" })).toBe(true);
    expect(relevant({ from: "x@fixture-group.example.attacker.test", subject: "Confirm your identity" })).toBe(false);
    expect(relevantOracleCodeHeader({ host, company: "Nobody Else" })({ from: "x@mail.fixture-group.example", subject: "Confirm your identity" })).toBe(false);
  });

  it("still rejects Greenhouse, Workday, and iCIMS mail for a company whose label would match", () => {
    // Each sender's registrable name equals the company's label, and the site rule still rejects it first.
    expect(relevantOracleCodeHeader({ host, company: "Greenhouse" })({ from: "no-reply@greenhouse.io", subject: "Confirm your identity" })).toBe(false);
    expect(relevantOracleCodeHeader({ host, company: "Workday" })({ from: "x@workday.com", subject: "Confirm your identity" })).toBe(false);
    expect(relevantOracleCodeHeader({ host, company: "iCIMS" })({ from: "x@icims.com", subject: "Confirm your identity" })).toBe(false);
    expect(relevantOracleCodeHeader({ host, company: "Myworkday" })({ from: "x@myworkday.com", subject: "Confirm your identity" })).toBe(false);
  });

  it("finds the code in a laboratory-shaped message after the click", () => {
    const staffing = message({ from: "STAFFING <staffing@fnl.example>", subject: "Confirm your identity" });
    expect(findOracleVerificationCode([staffing], { host, company: "Fixture National Laboratory", since: SINCE })).toEqual({ kind: "found", code: CODE });
    expect(findOracleVerificationCode([staffing], { host, company: "Another Company", since: SINCE })).toEqual({ kind: "none" });
  });
});

describe("Oracle code forms", () => {
  it("reads a six-digit code after or before an anchor, in text or HTML only", () => {
    expect(oracleCodesIn(message())).toEqual([CODE]);
    expect(oracleCodesIn(message({ text: `Code: ${CODE}` }))).toEqual([CODE]);
    expect(oracleCodesIn(message({ text: `${CODE} is your verification code.` }))).toEqual([CODE]);
    expect(oracleCodesIn(message({ text: `Use this PIN to verify your email:\n\n${CODE}\n` }))).toEqual([CODE]);
    expect(oracleCodesIn(message({ text: `Your one-time passcode\n${CODE}` }))).toEqual([CODE]);
    expect(oracleCodesIn(message({ text: "", html: `<p>Your verification code is</p><p><strong>${CODE}</strong></p>` }))).toEqual([CODE]);
  });

  it("ignores five- and seven-digit numbers and a number with no anchor", () => {
    expect(oracleCodesIn(message({ text: "Your verification code is 48291." }))).toEqual([]);
    expect(oracleCodesIn(message({ text: "Your verification code is 4829135." }))).toEqual([]);
    expect(oracleCodesIn(message({ text: "Thank you for your interest in Job 123456 at Fixture Robotics." }))).toEqual([]);
  });
});

describe("findOracleVerificationCode", () => {
  const target = { ...TARGET, since: SINCE };

  it("keeps mail from 30 s before the click on", () => {
    expect(findOracleVerificationCode([message({ receivedAt: new Date(SINCE.getTime() - 31_000) })], target)).toEqual({ kind: "none" });
    expect(findOracleVerificationCode([message({ receivedAt: new Date(SINCE.getTime() - 29_000) })], target)).toEqual({ kind: "found", code: CODE });
  });

  it("is ambiguous on two distinct codes and found on the same code twice", () => {
    expect(findOracleVerificationCode([message(), message({ text: `Your verification code is ${OTHER_CODE}.` })], target)).toEqual({ kind: "ambiguous", count: 2 });
    expect(findOracleVerificationCode([message(), message()], target)).toEqual({ kind: "found", code: CODE });
  });

  it("finds none in irrelevant mail", () => {
    expect(findOracleVerificationCode([message({ from: "Greenhouse <no-reply@us.greenhouse-mail.io>" })], target)).toEqual({ kind: "none" });
  });
});

describe("pollOracleVerificationCode", () => {
  const target = { ...TARGET, since: SINCE };

  it("finds the code on the second poll and closes the mailbox", async () => {
    const { factory, calls } = fakeMailbox([[], [message()]]);
    const result = await pollOracleVerificationCode(factory, target, { pollMs: 1, timeoutMs: 1_000, sleep: noSleep });
    expect(result).toEqual({ kind: "found", code: CODE });
    expect(calls).toEqual({ opened: 1, reads: 2, closed: 1 });
  });

  it("times out with none and closes the mailbox", async () => {
    const { factory, calls } = fakeMailbox([[]]);
    let clock = 0;
    const sleep = async (ms: number) => { clock += ms; };
    vi.spyOn(Date, "now").mockImplementation(() => 1_000_000 + clock);
    try {
      const result = await pollOracleVerificationCode(factory, target, { pollMs: 10_000, timeoutMs: 30_000, sleep });
      expect(result).toEqual({ kind: "none" });
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    expect(calls.closed).toBe(1);
    expect(calls.reads).toBeGreaterThanOrEqual(3);
  });

  it("names an opening failure and a read failure with fixed phrases", async () => {
    const failing: VerificationMailboxFactory = async () => { throw new Error("imap: secret server text"); };
    await expect(pollOracleVerificationCode(failing, target, { sleep: noSleep })).rejects.toEqual(new MailboxUnavailable("the mailbox could not be opened"));
    const { factory, calls } = fakeMailbox([[]], { readError: new Error("imap: secret server text") });
    await expect(pollOracleVerificationCode(factory, target, { sleep: noSleep })).rejects.toEqual(new MailboxUnavailable("the mailbox could not be read"));
    expect(calls.closed).toBe(1);
  });

  it("passes a MailboxUnavailable through unchanged", async () => {
    const refused: VerificationMailboxFactory = async () => { throw new MailboxUnavailable("the mailbox refused the sign-in"); };
    await expect(pollOracleVerificationCode(refused, target, { sleep: noSleep })).rejects.toThrow("the mailbox refused the sign-in");
  });
});
