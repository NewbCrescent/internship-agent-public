/**
 * Greenhouse's emailed security code, from a fake mailbox only (no network,
 * no real mail): dot-bounded greenhouse-mail.io / greenhouse.io senders, a
 * subject naming the security code and the company first and, after 60 s of
 * polling without one, any Greenhouse organization (job-wrapping boards),
 * mail from 30 s before the submit click on, the 6–8 character token after a
 * "code …:" anchor (letters only too, in text or HTML), exactly one distinct
 * code or a hold, bounded polling with mailbox failures as fixed phrases,
 * non-Greenhouse pages unsupported without opening the mailbox, and the code
 * never logged. The wording and the HTML-only structure were checked against
 * a real message's headers and structure (no real values are used); every
 * code, company and organization here is fictional.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";

import {
  findGreenhouseSecurityCode,
  greenhouseMailSender,
  greenhouseSecurityCodeHeader,
  greenhouseSecurityCodeLookup,
  MailboxUnavailable,
  pollGreenhouseSecurityCode,
  relevantSecurityCodeHeader,
  SECURITY_CODE_ANY_ORGANIZATION_AFTER_MS,
  securityCodesIn,
  type MailMessage,
  type VerificationMailbox,
  type VerificationMailboxFactory
} from "@internship-agent/agent";

const CODE = "K7QPZXMW";
const OTHER_CODE = "R4TV9BNC";
const LETTERS_CODE = "QWERTYUI";
const DIGITS_CODE = "40271936";
const ALL_CODES = [CODE, OTHER_CODE, LETTERS_CODE, DIGITS_CODE];
const COMPANY = "Fixture Robotics";
const WRAPPER = "Fixture Job Wrapping";
const GREENHOUSE_URL = "https://job-boards.greenhouse.io/fixturerobotics/jobs/1000001";
const SINCE = new Date("2026-11-20T10:08:00.000Z");

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    from: "Greenhouse <no-reply@us.greenhouse-mail.io>",
    subject: `Security code for your application to ${COMPANY}`,
    receivedAt: new Date(SINCE.getTime() + 60_000),
    text: `Copy and paste this code into the security code field on your application: ${CODE}\n\nAfter you enter the code, resubmit your application.`,
    html: "",
    ...overrides
  };
}

/** Greenhouse's HTML-only security-code mail naming the board's organization (a job-wrapping service), not the posting's company. */
const wrapped = (code = DIGITS_CODE, overrides: Partial<MailMessage> = {}) => message({
  subject: `Security code for your application to ${WRAPPER}`,
  text: "",
  html: `<html><body><table><tr><td><img src="cid:logo" alt=""></td></tr><tr><td><p>Copy and paste this code into the security code field on your application:</p><p style="font-size:24px"><strong>${code}</strong></p><p>After you enter the code, resubmit your application.</p><p>© 2026 Greenhouse</p></td></tr></table></body></html>`,
  ...overrides
});

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

/** Fakes Date only, starting 5 s after the click; the returned sleep moves it forward. */
function fakeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(SINCE.getTime() + 5_000));
  return async (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
}

const spies: MockInstance[] = [];
beforeAll(() => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) spies.push(vi.spyOn(console, method));
});
afterAll(() => {
  // The code is never written to the console, by any path this file exercises.
  for (const spy of spies) {
    const seen = JSON.stringify(spy.mock.calls);
    for (const code of ALL_CODES) expect(seen.includes(code)).toBe(false);
    spy.mockRestore();
  }
});

describe("greenhouseMailSender", () => {
  it.each([
    ["Greenhouse <no-reply@us.greenhouse-mail.io>", true],
    ["no-reply@greenhouse.io", true],
    ["No Reply <no-reply@greenhouse-mail.io.>", true],
    ["x@notgreenhouse.io", false],
    ["x@greenhouse.io.example.test", false],
    ["x@greenhouse-mail.io.example", false],
    ["Greenhouse greenhouse-mail.io", false]
  ])("%s → %s", (from, expected) => {
    expect(greenhouseMailSender(from)).toBe(expected);
  });
});

describe("relevantSecurityCodeHeader", () => {
  const relevant = relevantSecurityCodeHeader(`${COMPANY}, Inc.`);
  const from = "Greenhouse <no-reply@us.greenhouse-mail.io>";
  it("takes a Greenhouse security-code subject naming the company, in any case", () => {
    expect(relevant({ from, subject: `Security code for your application to ${COMPANY}` })).toBe(true);
    expect(relevant({ from, subject: `Your security code for your application to ${COMPANY.toLowerCase()}` })).toBe(true);
  });
  it("refuses another company, a partial name, another subject, or another sender", () => {
    expect(relevant({ from, subject: "Security code for your application to Other Fixtures" })).toBe(false);
    expect(relevant({ from, subject: "Security code for your application to Fixture" })).toBe(false);
    expect(relevant({ from, subject: `Thank you for applying to ${COMPANY}` })).toBe(false);
    expect(relevant({ from: "x@greenhouse.io.example.test", subject: `Security code for your application to ${COMPANY}` })).toBe(false);
  });
});

describe("greenhouseSecurityCodeHeader", () => {
  const from = "Greenhouse <no-reply@us.greenhouse-mail.io>";
  it("takes a Greenhouse security-code subject naming any organization", () => {
    expect(greenhouseSecurityCodeHeader({ from, subject: `Security code for your application to ${WRAPPER}` })).toBe(true);
  });
  it("refuses another sender or another subject", () => {
    expect(greenhouseSecurityCodeHeader({ from: "x@greenhouse.io.example.test", subject: `Security code for your application to ${WRAPPER}` })).toBe(false);
    expect(greenhouseSecurityCodeHeader({ from, subject: `Thank you for applying to ${WRAPPER}` })).toBe(false);
  });
});

describe("securityCodesIn", () => {
  it("reads the token after the template's anchor, never resubmit or application", () => {
    expect(securityCodesIn(message())).toEqual([CODE]);
  });
  it("reads a letters-only code", () => {
    expect(securityCodesIn(message({ text: `Copy and paste this code into the security code field on your application: ${LETTERS_CODE}` }))).toEqual([LETTERS_CODE]);
  });
  it("reads the same email sent as HTML", () => {
    expect(securityCodesIn(message({
      text: "",
      html: `<p>Copy and paste this code into the security code field on your application:</p><p><strong>${CODE}</strong></p><p>After you enter the code, resubmit your application.</p>`
    }))).toEqual([CODE]);
  });
  it("takes no 5- or 9-character token and nothing without a colon after code", () => {
    expect(securityCodesIn(message({ text: "Your security code: AB12C" }))).toEqual([]);
    expect(securityCodesIn(message({ text: "Your security code: AB12CD34E" }))).toEqual([]);
    expect(securityCodesIn(message({ text: `Enter the security code ${CODE} on your application` }))).toEqual([]);
    expect(securityCodesIn(message({ text: "After you enter the code, resubmit your application." }))).toEqual([]);
  });
});

describe("findGreenhouseSecurityCode", () => {
  const target = { company: COMPANY, since: SINCE };
  it("finds one code, also when it appears in text and HTML or in two messages", () => {
    expect(findGreenhouseSecurityCode([message()], target)).toEqual({ kind: "found", code: CODE });
    expect(findGreenhouseSecurityCode([message({ html: `<p>code: <b>${CODE}</b></p>` })], target)).toEqual({ kind: "found", code: CODE });
    expect(findGreenhouseSecurityCode([message(), message()], target)).toEqual({ kind: "found", code: CODE });
  });
  it("calls two distinct codes ambiguous", () => {
    const second = message({ text: `Copy and paste this code into the security code field on your application: ${OTHER_CODE}` });
    expect(findGreenhouseSecurityCode([message(), second], target)).toEqual({ kind: "ambiguous", count: 2 });
  });
  it("uses mail from 30 s before the click on and ignores older mail", () => {
    expect(findGreenhouseSecurityCode([message({ receivedAt: new Date(SINCE.getTime() - 31_000) })], target)).toEqual({ kind: "none" });
    expect(findGreenhouseSecurityCode([message({ receivedAt: new Date(SINCE.getTime() - 29_000) })], target)).toEqual({ kind: "found", code: CODE });
  });
  it("ignores another sender or another company", () => {
    expect(findGreenhouseSecurityCode([message({ from: "x@greenhouse.io.example.test" })], target)).toEqual({ kind: "none" });
    expect(findGreenhouseSecurityCode([message({ subject: "Security code for your application to Other Fixtures" })], target)).toEqual({ kind: "none" });
  });
  it("reads mail naming another Greenhouse organization only with anyOrganization", () => {
    expect(findGreenhouseSecurityCode([wrapped()], target)).toEqual({ kind: "none" });
    expect(findGreenhouseSecurityCode([wrapped()], target, { anyOrganization: true })).toEqual({ kind: "found", code: DIGITS_CODE });
  });
  it("prefers mail naming the posting's company over another organization's", () => {
    expect(findGreenhouseSecurityCode([wrapped(), message()], target, { anyOrganization: true })).toEqual({ kind: "found", code: CODE });
  });
  it("calls two other-organization codes ambiguous", () => {
    expect(findGreenhouseSecurityCode([wrapped(), wrapped(OTHER_CODE)], target, { anyOrganization: true })).toEqual({ kind: "ambiguous", count: 2 });
  });
  it("keeps the window and the sender for other organizations", () => {
    expect(findGreenhouseSecurityCode([wrapped(DIGITS_CODE, { receivedAt: new Date(SINCE.getTime() - 31_000) })], target, { anyOrganization: true })).toEqual({ kind: "none" });
    expect(findGreenhouseSecurityCode([wrapped(DIGITS_CODE, { from: "x@greenhouse.io.example.test" })], target, { anyOrganization: true })).toEqual({ kind: "none" });
  });
});

describe("pollGreenhouseSecurityCode", () => {
  const target = { company: COMPANY, since: SINCE };
  it("returns the code that arrives on the third read, and closes the mailbox", async () => {
    const { factory, calls } = fakeMailbox([[], [], [message()]]);
    const sleeps: number[] = [];
    const result = await pollGreenhouseSecurityCode(factory, target, { pollMs: 10, timeoutMs: 1_000, sleep: async (ms) => { sleeps.push(ms); } });
    expect(result).toEqual({ kind: "found", code: CODE });
    expect(calls).toEqual({ opened: 1, reads: 3, closed: 1 });
    expect(sleeps).toEqual([10, 10]);
  });
  it("gives up with none when nothing arrives in time", async () => {
    const { factory, calls } = fakeMailbox([[]]);
    expect(await pollGreenhouseSecurityCode(factory, target, { pollMs: 10, timeoutMs: 35, sleep: noSleep })).toEqual({ kind: "none" });
    expect(calls.closed).toBe(1);
    expect(calls.reads).toBeGreaterThanOrEqual(1);
  });
  it("returns ambiguous on the first read", async () => {
    const second = message({ text: `Copy and paste this code into the security code field on your application: ${OTHER_CODE}` });
    const { factory, calls } = fakeMailbox([[message(), second]]);
    expect(await pollGreenhouseSecurityCode(factory, target, { pollMs: 10, timeoutMs: 1_000, sleep: noSleep })).toEqual({ kind: "ambiguous", count: 2 });
    expect(calls).toEqual({ opened: 1, reads: 1, closed: 1 });
  });
  it("turns an opening failure into a fixed phrase without the server's text", async () => {
    const failing: VerificationMailboxFactory = async () => { throw new Error("secret server text"); };
    const error = await pollGreenhouseSecurityCode(failing, target, { sleep: noSleep }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailboxUnavailable);
    expect((error as Error).message).toBe("the mailbox could not be opened");
  });
  it("turns a read failure into a fixed phrase and still closes the mailbox", async () => {
    const { factory, calls } = fakeMailbox([[]], { readError: new Error("secret server text") });
    const error = await pollGreenhouseSecurityCode(factory, target, { sleep: noSleep }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailboxUnavailable);
    expect((error as Error).message).toBe("the mailbox could not be read");
    expect(calls.closed).toBe(1);
  });
});

describe("pollGreenhouseSecurityCode on a job-wrapping board", () => {
  const target = { company: COMPANY, since: SINCE };
  afterEach(() => { vi.useRealTimers(); });
  it("finds the code in Greenhouse's mail naming the board's organization once 60 s have passed (Artefact run 97845bf4)", async () => {
    const { factory, calls } = fakeMailbox([[wrapped()]]);
    expect(await pollGreenhouseSecurityCode(factory, target, { sleep: fakeClock() })).toEqual({ kind: "found", code: DIGITS_CODE });
    // Reads at +0 s … +60 s; the 7th is the first at SECURITY_CODE_ANY_ORGANIZATION_AFTER_MS.
    expect(SECURITY_CODE_ANY_ORGANIZATION_AFTER_MS).toBe(60_000);
    expect(calls).toEqual({ opened: 1, reads: 7, closed: 1 });
  });
  it("takes mail naming the posting's company at once, even with another organization's code already there", async () => {
    const { factory, calls } = fakeMailbox([[wrapped()], [wrapped(), message()]]);
    expect(await pollGreenhouseSecurityCode(factory, target, { sleep: fakeClock() })).toEqual({ kind: "found", code: CODE });
    expect(calls.reads).toBe(2);
  });
  it("stays none when only another organization's mail arrives and the wait is under 60 s", async () => {
    const { factory, calls } = fakeMailbox([[wrapped()]]);
    expect(await pollGreenhouseSecurityCode(factory, target, { pollMs: 10_000, timeoutMs: 50_000, sleep: fakeClock() })).toEqual({ kind: "none" });
    expect(calls.closed).toBe(1);
  });
  it("holds two other-organization codes as ambiguous after 60 s", async () => {
    const { factory } = fakeMailbox([[wrapped(), wrapped(OTHER_CODE)]]);
    expect(await pollGreenhouseSecurityCode(factory, target, { sleep: fakeClock() })).toEqual({ kind: "ambiguous", count: 2 });
  });
});

describe("greenhouseSecurityCodeLookup", () => {
  const wait = { pollMs: 10, timeoutMs: 30, sleep: noSleep };
  afterEach(() => { vi.useRealTimers(); });
  it("leaves non-Greenhouse pages unsupported without opening the mailbox", async () => {
    const { factory, calls } = fakeMailbox([[message()]]);
    const lookup = greenhouseSecurityCodeLookup({ mailbox: factory, company: COMPANY, wait });
    for (const url of ["https://jobs.lever.co/fixturerobotics/1/apply", "https://jobs.ashbyhq.com/fixturerobotics/1/application", "not a url"]) {
      expect(await lookup({ url, clickedAt: SINCE })).toEqual({ kind: "unsupported" });
    }
    expect(calls.opened).toBe(0);
  });
  it("is no-mailbox without a mailbox and none for a blank company (without opening it)", async () => {
    expect(await greenhouseSecurityCodeLookup({ mailbox: null, company: COMPANY, wait })({ url: GREENHOUSE_URL, clickedAt: SINCE })).toEqual({ kind: "no-mailbox" });
    const { factory, calls } = fakeMailbox([[message()]]);
    expect(await greenhouseSecurityCodeLookup({ mailbox: factory, company: "  ", wait })({ url: GREENHOUSE_URL, clickedAt: SINCE })).toEqual({ kind: "none" });
    expect(calls.opened).toBe(0);
  });
  it("is unavailable when the mailbox throws", async () => {
    const failing: VerificationMailboxFactory = async () => { throw new Error("secret server text"); };
    expect(await greenhouseSecurityCodeLookup({ mailbox: failing, company: COMPANY, wait })({ url: GREENHOUSE_URL, clickedAt: SINCE })).toEqual({ kind: "unavailable" });
  });
  it("passes found through and drops the ambiguous count", async () => {
    const found = fakeMailbox([[message()]]);
    expect(await greenhouseSecurityCodeLookup({ mailbox: found.factory, company: COMPANY, wait })({ url: GREENHOUSE_URL, clickedAt: SINCE }))
      .toEqual({ kind: "found", code: CODE });
    const second = message({ text: `Copy and paste this code into the security code field on your application: ${OTHER_CODE}` });
    const ambiguous = fakeMailbox([[message(), second]]);
    expect(await greenhouseSecurityCodeLookup({ mailbox: ambiguous.factory, company: COMPANY, wait })({ url: GREENHOUSE_URL, clickedAt: SINCE }))
      .toEqual({ kind: "ambiguous" });
  });
  it("passes a job-wrapping board's code through", async () => {
    const { factory } = fakeMailbox([[wrapped()]]);
    expect(await greenhouseSecurityCodeLookup({ mailbox: factory, company: COMPANY, wait: { sleep: fakeClock() } })({ url: GREENHOUSE_URL, clickedAt: SINCE }))
      .toEqual({ kind: "found", code: DIGITS_CODE });
  });
});
