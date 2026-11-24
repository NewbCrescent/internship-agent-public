/**
 * Workday candidate accounts in real Chromium against the synthetic Workday
 * fixture, routed to fictional `*.wd1.myworkdayjobs.com` hosts inside one
 * browser context (every other request is aborted, so no network is used).
 * Proves: the password is saved (0600) before the create submit, the terms
 * checkbox is logged and the honeypot untouched, the next run signs in with
 * the saved password, a verification link from a fake mailbox is opened in
 * the run's context, the real sites' account screen (the "Create
 * Account/Sign In" step drawn before its form, noCaptchaWrapper without a
 * challenge, and the invisible reCAPTCHA badge, which is not a CAPTCHA
 * either) is read as the sign-in wall and creates the account, and
 * CAPTCHA, existing-account, text-message and missing-mail screens hold the host; the password never reaches the
 * database, logs, or errors. After a create submit the agent waits up to 60
 * seconds (a virtual clock stands in for time): a create that Workday answers
 * after 45 seconds goes on (signed in, or the verification email), "already
 * exists" and no answer lead to one sign-in with the saved password (signed
 * in when the account exists, held otherwise), and an error banner holds with
 * Workday's text. After a create that shows the sign-in form (the real sites'
 * flow), the sign-in click goes to the form's own click filter, never a
 * header "Sign In" filter earlier on the page (decoy, synthetic); a plain-text
 * "not been verified" notice after the sign-in submit goes to the
 * verification email (notice); and a sign-in Workday ignores right after the
 * create goes to the verification email too (quiet). Never reads process.env
 * for accounts or Gmail.
 *
 * Usage: pnpm test:browser:workday-account
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { chromium, type Page } from "playwright-core";

import {
  ensureWorkdayAccount,
  getWorkdayAccount,
  readWorkdayAccounts,
  WorkdayAccountHeld,
  workdayAccountWait,
  type MailMessage,
  type VerificationMailboxFactory,
  type WorkdayAccountRuntime
} from "@internship-agent/agent";
import { createWorkdayPage, type WorkdayPage, type WorkdaySettleOptions, type WorkdayWaitClock } from "@internship-agent/browser";
import { createDatabase, getBrowserSession, seedDevelopmentData } from "@internship-agent/db";

const PREFIX = "internship-agent-workday-account-";
const EMAIL = "jordan@example.test";
const COMPANY = "Fixture Aerospace";
const PASSWORD_RULE = /^(?=.*[A-HJ-NP-Z])(?=.*[a-km-z])(?=.*[2-9])(?=.*[!@#$%^&*])[A-HJ-NP-Za-km-z2-9!@#$%^&*]{16}$/;

type FixtureAccount = { honeypotTyped: boolean; termsChecked: boolean; creates: number; signIns: number; emailMethodClicks: number; headerClicks: number };

/**
 * A virtual clock for the account step's waits: each sleep advances virtual
 * time by its length and waits 5 ms real. Once virtual time reaches
 * `releaseAtMs`, `gate` resolves (the fixture's slow create then completes)
 * and each sleep waits 50 ms real, so the page has time to draw its answer
 * before the virtual deadline. Without `releaseAtMs` the gate never resolves.
 */
function virtualClock(releaseAtMs?: number): { clock: WorkdayWaitClock; gate: Promise<void> } {
  let now = 0;
  let released = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    gate,
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        if (!released && releaseAtMs !== undefined && now >= releaseAtMs) {
          released = true;
          release();
        }
        await new Promise((resolve) => setTimeout(resolve, released ? 50 : 5));
      }
    }
  };
}

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), PREFIX));
  const failures: string[] = [];
  const captured: string[] = [];
  const caughtMessages: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const browser = await chromium.launch();
  try {
    const database = createDatabase(join(temp, "test.sqlite"));
    seedDevelopmentData(database);
    const jobId = (database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string }).id;
    const file = join(temp, "config", "workday-accounts.json");
    let mail: () => Promise<MailMessage[]> = async () => [];
    const mailbox: VerificationMailboxFactory = async () => ({ messagesSince: () => mail(), close: async () => undefined });
    const runtime: WorkdayAccountRuntime = { email: EMAIL, file, mailbox, mailPollMs: 50, mailTimeoutMs: 500 };

    const fixture = readFileSync(join(process.cwd(), "testing-harness/browser/fixtures/workday-application.html"), "utf8");
    const context = await browser.newContext();
    const activationAttempts = new Map<string, number>();
    const navigationFailureHost = "fixture-silent-quiet-navigation.wd1.myworkdayjobs.com";
    await context.route("**/*", async (route) => {
      const request = route.request();
      let host = "";
      try {
        const url = new URL(request.url());
        host = url.hostname;
        if (request.resourceType() === "document" && url.pathname.startsWith("/External/activate/")) {
          activationAttempts.set(host, (activationAttempts.get(host) ?? 0) + 1);
          if (host === navigationFailureHost) return route.abort();
        }
      } catch { /* not a URL */ }
      if (request.resourceType() === "document" && host.endsWith(".wd1.myworkdayjobs.com")) {
        await route.fulfill({ status: 200, contentType: "text/html", body: fixture });
      } else {
        await route.abort();
      }
    });
    // At the moment of a create submit, the accounts file must already hold the pending password.
    const savedBeforeSubmit = new Map<string, boolean>();
    // A slow create: Workday answers only once the host's gate opens (45 virtual seconds).
    const slowGates = new Map<string, Promise<void>>();
    const accountSubmits = new Map<string, string[]>();
    await context.exposeBinding("onFixtureAccountSubmit", async (source, label: string) => {
      const host = new URL(source.page.url()).hostname;
      accountSubmits.set(host, [...(accountSubmits.get(host) ?? []), label]);
      if (label !== "Create Account") return;
      const entry = (() => { try { return getWorkdayAccount(file, host); } catch { return null; } })();
      savedBeforeSubmit.set(host, entry?.account === "pending" && typeof entry.password === "string" && entry.password.length >= 8);
      const gate = slowGates.get(host);
      if (gate) await gate;
    });
    context.on("console", (message) => captured.push(message.text()));
    for (const level of ["log", "warn", "error"] as const) {
      console[level] = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
    }

    const urlFor = (host: string, mode: string) => `https://${host}/External/job/US-WA/Intern_R1?account=${mode}`;
    const fixtureState = (tab: Page) => tab.evaluate(() => (window as unknown as { fixtureAccount: FixtureAccount }).fixtureAccount);
    const storedAccount = (tab: Page) => tab.evaluate((email) =>
      (JSON.parse(localStorage.getItem("fixture-workday-accounts") || "{}") as Record<string, { password: string; verified: boolean; token: string }>)[email] ?? null, EMAIL);
    const events = () => (database.prepare("SELECT detail FROM application_events WHERE job_id = ?").all(jobId) as Array<{ detail: string | null }>).map((row) => row.detail ?? "");

    async function scenario(
      name: string,
      host: string,
      mode: string,
      accountWait?: WorkdaySettleOptions,
      onTab?: (tab: Page) => void
    ): Promise<{ tab: Page; page: WorkdayPage; result: string | null; error: Error | null }> {
      const tab = await context.newPage();
      onTab?.(tab);
      await tab.goto(urlFor(host, mode));
      const page = createWorkdayPage(tab);
      await page.enterApplication();
      if (!(await page.signInRequired())) failures.push(`${name}: the fixture did not show the account wall`);
      try {
        const result = await ensureWorkdayAccount(page, {
          database, jobId, applicationUrl: urlFor(host, mode), company: COMPANY, candidateEmail: EMAIL,
          runtime: accountWait ? { ...runtime, accountWait } : runtime, mode: "create"
        });
        return { tab, page, result, error: null };
      } catch (error) {
        const caught = error instanceof Error ? error : new Error(String(error));
        caughtMessages.push(caught.message);
        return { tab, page, result: null, error: caught };
      }
    }
    const opensFlow = async (name: string, page: WorkdayPage) => {
      if (await page.enterApplication() !== "flow" || await page.signInRequired()) failures.push(`${name}: the application did not open`);
      else if ((await page.activeStep())?.name !== "My Information") failures.push(`${name}: the application is not on My Information`);
    };
    const held = (name: string, outcome: { error: Error | null; result: string | null }, text: string) => {
      if (!(outcome.error instanceof WorkdayAccountHeld)) failures.push(`${name}: expected a hold, got ${outcome.result ?? outcome.error?.message}`);
      else if (!outcome.error.message.includes(text)) failures.push(`${name}: the hold does not mention "${text}"`);
    };

    // Create: password saved first, terms logged, honeypot untouched, signed in.
    const createHost = "fixture-create.wd1.myworkdayjobs.com";
    const created = await scenario("create", createHost, "create");
    if (created.result !== "created") failures.push(`create: expected "created", got ${created.result ?? created.error?.message}`);
    if (savedBeforeSubmit.get(createHost) !== true) failures.push("create: the password was not saved before the create submit");
    await opensFlow("create", created.page);
    if ((statSync(file).mode & 0o777) !== 0o600) failures.push(`create: accounts file mode ${(statSync(file).mode & 0o777).toString(8)}`);
    if ((statSync(dirname(file)).mode & 0o777) !== 0o700) failures.push(`create: accounts directory mode ${(statSync(dirname(file)).mode & 0o777).toString(8)}`);
    const createEntry = getWorkdayAccount(file, createHost);
    if (createEntry?.account !== "created") failures.push(`create: entry is ${createEntry?.account}`);
    if (!createEntry?.password || !PASSWORD_RULE.test(createEntry.password)) failures.push("create: the saved password breaks the password policy");
    const createState = await fixtureState(created.tab);
    if (createState.honeypotTyped) failures.push("create: the robot honeypot was typed in");
    if (!createState.termsChecked) failures.push("create: the terms checkbox was not checked");
    if (createState.creates !== 1) failures.push(`create: ${createState.creates} create submits`);
    if ((await storedAccount(created.tab))?.password !== createEntry?.password) failures.push("create: Workday holds a different password than the saved one");
    if (getBrowserSession(database, `workday:${createHost}/External`)?.status !== "connected") failures.push("create: the session is not connected");
    if (!events().includes(`Workday ${createHost}: account created with your email; the password is saved locally.`)) failures.push("create: no account-created event");
    if (!events().some((detail) => detail.startsWith(`Workday ${createHost}: checked "Yes, I have read and consent to the Terms and Conditions"`))) failures.push("create: no terms event");

    // The real sites' screen (employer-a.wd115, employer-b.wd3): the flow with its "Create Account/Sign In" step
    // draws before the account form, inputs sit in formField-* containers, and noCaptchaWrapper wraps
    // the create button without any challenge. It must read as the sign-in wall and create the account.
    const realHost = "fixture-real.wd1.myworkdayjobs.com";
    const realTab = await context.newPage();
    await realTab.goto(urlFor(realHost, "create&markup=real"));
    const realPage = createWorkdayPage(realTab);
    const realEntry = await realPage.enterApplication();
    if (realEntry !== "sign-in") failures.push(`real: enterApplication returned "${realEntry}", not "sign-in"`);
    if (!(await realPage.signInRequired())) failures.push("real: the account screen was not read as the sign-in wall");
    let realResult: string | null = null;
    try {
      realResult = await ensureWorkdayAccount(realPage, {
        database, jobId, applicationUrl: urlFor(realHost, "create&markup=real"), company: COMPANY, candidateEmail: EMAIL, runtime, mode: "create"
      });
    } catch (error) {
      caughtMessages.push(error instanceof Error ? error.message : String(error));
      failures.push(`real: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (realResult !== "created") failures.push(`real: expected "created", got ${realResult}`);
    if (savedBeforeSubmit.get(realHost) !== true) failures.push("real: the password was not saved before the create submit");
    const realState = await fixtureState(realTab);
    if (realState.honeypotTyped) failures.push("real: the robot honeypot was typed in");
    if (!realState.termsChecked) failures.push("real: the terms checkbox was not checked");
    if (realState.creates !== 1) failures.push(`real: ${realState.creates} create submits`);
    await opensFlow("real", realPage);

    // The next run on the same host signs in with the saved password.
    const again = await scenario("sign-in", createHost, "create");
    if (again.result !== "signed-in") failures.push(`sign-in: expected "signed-in", got ${again.result ?? again.error?.message}`);
    await opensFlow("sign-in", again.page);
    const againState = await fixtureState(again.tab);
    if (againState.honeypotTyped) failures.push("sign-in: the robot honeypot was typed in");
    if (againState.signIns !== 1 || againState.creates !== 0) failures.push(`sign-in: ${againState.signIns} sign-ins and ${againState.creates} creates`);
    if (getWorkdayAccount(file, createHost)?.password !== createEntry?.password) failures.push("sign-in: the saved password changed");

    // A plain submit stays mounted even after dispatch, with or without a response.
    // A disabled submit must stop at the click. A neighboring control for a
    // different action must not take the click from a visible Sign In button.
    for (const mode of ["no-request", "response", "blocked", "unrelated-filter"] as const) {
      const name = `${mode} sign-in submit`;
      const host = `fixture-${mode}-submit.wd1.myworkdayjobs.com`;
      const blocked = mode === "blocked";
      const tab = await context.newPage();
      if (mode === "response") await tab.route("**/account-fixture?diagnostic=private", (route) => route.fulfill({ status: 401 }));
      await tab.goto(urlFor(host, "create"));
      const page = createWorkdayPage(tab);
      await page.enterApplication();
      if (!page.signInToAccount) throw new Error("the Workday adapter does not expose sign-in");
      await tab.locator('[data-automation-id="signInLink"]').click();
      const submit = tab.locator('[data-automation-id="signInSubmitButton"]');
      await submit.evaluate((button: HTMLButtonElement, mode) => {
        button.nextElementSibling?.remove();
        button.disabled = mode === "blocked";
        button.dataset.clicks = "0";
        if (mode === "unrelated-filter") {
          const otherAction = document.createElement("button");
          otherAction.type = "button";
          otherAction.textContent = "Account Help";
          otherAction.setAttribute("aria-label", "Account Help");
          otherAction.setAttribute("data-automation-id", "click_filter");
          otherAction.dataset.clicks = "0";
          otherAction.addEventListener("click", (event) => {
            event.stopPropagation();
            otherAction.dataset.clicks = String(Number(otherAction.dataset.clicks) + 1);
          });
          button.before(otherAction);
        }
        button.addEventListener("click", () => {
          button.dataset.clicks = String(Number(button.dataset.clicks) + 1);
          if (mode === "response") void fetch("/account-fixture?diagnostic=private", { method: "POST" });
        });
      }, mode);

      try {
        const outcome = await page.signInToAccount({ email: EMAIL, password: "fixture-password" }, host, {
          clock: virtualClock().clock,
          timeoutMs: 1_000
        });
        if (blocked || outcome.result !== "no-answer") failures.push(`${name}: unexpected outcome ${outcome.result}`);
        const traffic = mode === "response" ? "same-host response status: 401" : "no same-host request observed";
        const expected = `Workday did not answer the sign-in submit within 1 seconds; ${traffic}; no page transition observed`;
        if (!blocked && outcome.detail !== expected) failures.push(`${name}: incorrect timeout diagnostics`);
      } catch (error) {
        if (!blocked || !(error instanceof Error) || error.message !== "the Sign In button could not be clicked") {
          failures.push(`${name}: unexpected click error`);
        }
      }
      const clicks = await submit.getAttribute("data-clicks");
      if (clicks !== (blocked ? "0" : "1")) failures.push(`${name}: ${clicks} click events`);
      if (mode === "unrelated-filter") {
        const otherAction = tab.locator('[data-automation-id="click_filter"][aria-label="Account Help"]');
        if (await otherAction.getAttribute("data-clicks") !== "0") failures.push(`${name}: activated Account Help`);
      }
      await tab.close();
    }

    // Verification: the link comes from the (fake) mailbox and opens in the run's context.
    const verifyHost = "fixture-verify.wd1.myworkdayjobs.com";
    let verifyTab: Page | null = null;
    mail = async () => {
      const token = verifyTab ? (await storedAccount(verifyTab))?.token ?? "" : "";
      return [
        {
          from: "Fixture Verify <fixture-verify@myworkday.com>", subject: "Verify your candidate account", receivedAt: new Date(), text: "",
          html: `<a href="https://${verifyHost}/External/activate/${token}?a=1&amp;b=2">Verify</a> <a href="https://${verifyHost}/External">Careers</a>`
        },
        { from: "Deals <deals@evil.example>", subject: "Verify now", receivedAt: new Date(), text: "https://evil.example/activate/x", html: "" }
      ];
    };
    const verifyStart = await context.newPage();
    verifyTab = verifyStart;
    await verifyStart.goto(urlFor(verifyHost, "verify"));
    const verifyPage = createWorkdayPage(verifyStart);
    await verifyPage.enterApplication();
    let verifyResult: string | null = null;
    try {
      verifyResult = await ensureWorkdayAccount(verifyPage, {
        database, jobId, applicationUrl: urlFor(verifyHost, "verify"), company: COMPANY, candidateEmail: EMAIL, runtime, mode: "create"
      });
    } catch (error) {
      caughtMessages.push(error instanceof Error ? error.message : String(error));
      failures.push(`verify: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (verifyResult !== "signed-in" && verifyResult !== "created") failures.push(`verify: expected a sign-in, got ${verifyResult}`);
    await opensFlow("verify", verifyPage);
    if (!(await storedAccount(verifyStart))?.verified) failures.push("verify: the fixture account was not verified");
    if (!events().includes(`Workday ${verifyHost}: verification email found and opened.`)) failures.push("verify: no verification event");

    // No verification email: held, retried after an hour.
    mail = async () => [];
    const lateHost = "fixture-verify-late.wd1.myworkdayjobs.com";
    const late = await scenario("verify-late", lateHost, "verify");
    held("verify-late", late, "verification email not found");
    const lateEntry = getWorkdayAccount(file, lateHost);
    if (lateEntry?.account !== "created" || lateEntry.hold?.kind !== "verify-email" || lateEntry.hold.attempts !== 1) failures.push("verify-late: unexpected entry state");
    const gate = { runtime };
    if (!workdayAccountWait(gate, lateHost, EMAIL, new Date())?.includes("verification email not found")) failures.push("verify-late: the gate does not hold now");
    if (workdayAccountWait(gate, lateHost, EMAIL, new Date(Date.now() + 61 * 60_000)) !== null) failures.push("verify-late: the gate still holds after an hour");

    // CAPTCHA: held before any password is generated or typed.
    const captchaHost = "fixture-captcha.wd1.myworkdayjobs.com";
    const captcha = await scenario("captcha", captchaHost, "captcha");
    held("captcha", captcha, "CAPTCHA");
    if (getWorkdayAccount(file, captchaHost)?.password !== null) failures.push("captcha: a password was generated");
    if (await captcha.tab.inputValue('input[data-automation-id="email"]') !== "") failures.push("captcha: the email field was typed in");
    if ((await fixtureState(captcha.tab)).creates !== 0) failures.push("captcha: the create form was submitted");

    // An existing account the saved password does not open: one sign-in, then held, never reset.
    const existsHost = "fixture-exists.wd1.myworkdayjobs.com";
    const exists = await scenario("exists", existsHost, "exists");
    held("exists", exists, "already exists");
    held("exists", exists, "did not work");
    if (getWorkdayAccount(file, existsHost)?.account !== "refused") failures.push("exists: the account is not marked refused");
    if (!workdayAccountWait(gate, existsHost, EMAIL)?.includes("already exists")) failures.push("exists: the gate does not hold");
    const existsState = await fixtureState(exists.tab);
    if (existsState.signIns !== 1 || existsState.creates !== 1) failures.push(`exists: ${existsState.signIns} sign-ins and ${existsState.creates} creates`);

    // "Already exists" after Workday did store the account (a double submit): one sign-in opens it.
    const doubleHost = "fixture-double.wd1.myworkdayjobs.com";
    const double = await scenario("double", doubleHost, "double");
    if (double.result !== "created") failures.push(`double: expected "created", got ${double.result ?? double.error?.message}`);
    const doubleState = await fixtureState(double.tab);
    if (doubleState.signIns !== 1 || doubleState.creates !== 1) failures.push(`double: ${doubleState.signIns} sign-ins and ${doubleState.creates} creates`);
    const doubleEntry = getWorkdayAccount(file, doubleHost);
    if (doubleEntry?.account !== "created" || doubleEntry.hold !== null) failures.push(`double: entry is ${doubleEntry?.account} with hold ${doubleEntry?.hold?.kind}`);
    if (!events().includes(`Workday ${doubleHost}: Workday said an account already exists for your email; the agent signed in with the saved password.`)) failures.push("double: no sign-in event");
    await opensFlow("double", double.page);

    // A slow create: Workday answers after 45 seconds, within the 60-second wait.
    const slowHost = "fixture-slow.wd1.myworkdayjobs.com";
    const slowClock = virtualClock(45_000);
    slowGates.set(slowHost, slowClock.gate);
    const slow = await scenario("slow", slowHost, "create", { clock: slowClock.clock });
    if (slow.result !== "created") failures.push(`slow: expected "created", got ${slow.result ?? slow.error?.message}`);
    if ((await fixtureState(slow.tab)).creates !== 1) failures.push("slow: expected one create submit");
    if (slowClock.clock.now() < 45_000) failures.push(`slow: the agent stopped waiting at ${slowClock.clock.now()} virtual ms`);
    await opensFlow("slow", slow.page);

    // A slow create that then asks to verify the email: the Gmail verification flow goes on.
    const slowVerifyHost = "fixture-slow-verify.wd1.myworkdayjobs.com";
    let slowVerifyTab: Page | null = null;
    mail = async () => {
      const token = slowVerifyTab ? (await storedAccount(slowVerifyTab))?.token ?? "" : "";
      return [{
        from: "Fixture Verify <fixture-slow-verify@myworkday.com>", subject: "Verify your candidate account", receivedAt: new Date(), text: "",
        html: `<a href="https://${slowVerifyHost}/External/activate/${token}">Verify</a>`
      }];
    };
    const slowVerifyClock = virtualClock(45_000);
    slowGates.set(slowVerifyHost, slowVerifyClock.gate);
    const slowVerify = await scenario("slow-verify", slowVerifyHost, "verify", { clock: slowVerifyClock.clock }, (tab) => { slowVerifyTab = tab; });
    if (slowVerify.result !== "signed-in" && slowVerify.result !== "created") failures.push(`slow-verify: expected a sign-in, got ${slowVerify.result ?? slowVerify.error?.message}`);
    if (!events().includes(`Workday ${slowVerifyHost}: verification email found and opened.`)) failures.push("slow-verify: no verification event");
    if (!(await storedAccount(slowVerify.tab))?.verified) failures.push("slow-verify: the fixture account was not verified");
    await opensFlow("slow-verify", slowVerify.page);
    mail = async () => [];

    // The sign-in form after the create, under a header whose Sign In has its own click filter
    // (synthetic): the click goes to the form's filter, and the account signs in.
    const decoyHost = "fixture-decoy.wd1.myworkdayjobs.com";
    const decoy = await scenario("decoy", decoyHost, "signin-after&header=filter", { clock: virtualClock().clock });
    if (decoy.result !== "signed-in") failures.push(`decoy: expected "signed-in", got ${decoy.result ?? decoy.error?.message}`);
    const decoyState = await fixtureState(decoy.tab);
    if (decoyState.creates !== 1 || decoyState.signIns !== 1 || decoyState.headerClicks !== 0) {
      failures.push(`decoy: ${decoyState.creates} creates, ${decoyState.signIns} sign-ins and ${decoyState.headerClicks} header clicks`);
    }
    if (!events().includes(`Workday ${decoyHost}: account created with your email; the password is saved locally.`)) failures.push("decoy: no account-created event");
    await opensFlow("decoy", decoy.page);

    // The verification link for a host's unverified fixture account, from the (fake) mailbox.
    const linkFor = (host: string, tab: () => Page | null) => async (): Promise<MailMessage[]> => {
      const current = tab();
      const token = current ? (await storedAccount(current))?.token ?? "" : "";
      return [{
        from: `Fixture Verify <${host.split(".")[0]}@myworkday.com>`, subject: "Verify your candidate account", receivedAt: new Date(), text: "",
        html: `<a href="https://${host}/External/activate/${token}">Verify</a>`
      }];
    };

    // Signing in to the unverified account writes a plain-text notice (no error element) and keeps
    // the form: the verification email is opened and the agent signs in.
    const noticeHost = "fixture-notice.wd1.myworkdayjobs.com";
    let noticeTab: Page | null = null;
    mail = linkFor(noticeHost, () => noticeTab);
    const notice = await scenario("notice", noticeHost, "notice", { clock: virtualClock().clock }, (tab) => { noticeTab = tab; });
    if (notice.result !== "signed-in" && notice.result !== "created") failures.push(`notice: expected a sign-in, got ${notice.result ?? notice.error?.message}`);
    if (!events().includes(`Workday ${noticeHost}: verification email found and opened.`)) failures.push("notice: no verification event");
    if (!(await storedAccount(notice.tab))?.verified) failures.push("notice: the fixture account was not verified");
    await opensFlow("notice", notice.page);

    // Signing in to the unverified account changes nothing: right after the create, the agent looks
    // for the verification email instead of holding.
    const quietHost = "fixture-quiet.wd1.myworkdayjobs.com";
    let quietTab: Page | null = null;
    mail = linkFor(quietHost, () => quietTab);
    const quiet = await scenario("quiet", quietHost, "quiet", { clock: virtualClock().clock }, (tab) => { quietTab = tab; });
    if (quiet.result !== "signed-in" && quiet.result !== "created") failures.push(`quiet: expected a sign-in, got ${quiet.result ?? quiet.error?.message}`);
    if (!events().includes(`Workday ${quietHost}: Workday did not answer the sign-in after the account was created; the agent looks for the verification email.`)) {
      failures.push("quiet: no look-for-the-email event");
    }
    if (!events().includes(`Workday ${quietHost}: verification email found and opened.`)) failures.push("quiet: no verification event");
    if (!(await storedAccount(quiet.tab))?.verified) failures.push("quiet: the fixture account was not verified");
    await opensFlow("quiet", quiet.page);
    mail = async () => [];

    // No answer within 60 seconds, but the account was created: one sign-in opens it.
    const silentHost = "fixture-silent.wd1.myworkdayjobs.com";
    const silent = await scenario("silent", silentHost, "silent", { clock: virtualClock().clock });
    if (silent.result !== "created") failures.push(`silent: expected "created", got ${silent.result ?? silent.error?.message}`);
    const silentState = await fixtureState(silent.tab);
    if (silentState.signIns !== 1 || silentState.creates !== 1) failures.push(`silent: ${silentState.signIns} sign-ins and ${silentState.creates} creates`);
    await opensFlow("silent", silent.page);

    const chooserHost = "fixture-silent-chooser.wd1.myworkdayjobs.com";
    const chooser = await scenario("silent-chooser", chooserHost, "silent-chooser", { clock: virtualClock().clock });
    if (chooser.result !== "created") failures.push(`silent-chooser: expected "created", got ${chooser.result ?? chooser.error?.message}`);
    const chooserState = await fixtureState(chooser.tab);
    if (chooserState.creates !== 1 || chooserState.emailMethodClicks !== 1 || chooserState.signIns !== 1) {
      failures.push(`silent-chooser: ${chooserState.creates} creates, ${chooserState.emailMethodClicks} email method clicks, and ${chooserState.signIns} sign-ins`);
    }
    await opensFlow("silent-chooser", chooser.page);

    // A silent create and silent sign-in use a single tenant-correlated mailbox read.
    for (const kind of ["found", "none", "ambiguous", "unavailable", "generic", "navigation"]) {
      const name = `silent-quiet-${kind}`;
      const host = `fixture-${name}.wd1.myworkdayjobs.com`;
      let tab: Page | null = null;
      let reads = 0;
      const attemptsBefore = [...activationAttempts.values()].reduce((sum, count) => sum + count, 0);
      mail = async () => {
        reads += 1;
        if (accountSubmits.get(host)?.join(",") !== "Create Account,Sign In") failures.push(`${name}: mailbox read outside the first sign-in timeout`);
        if (kind === "unavailable") throw new Error("synthetic mailbox failure");
        if (kind === "none") return [];
        const messages = await linkFor(host, () => tab)();
        const message = messages[0]!;
        if (kind === "ambiguous") return [message, { ...message, html: `<a href="https://${host}/External/activate/another-fixture-token">Verify</a>` }];
        if (kind === "generic") return [{ ...message, html: '<a href="https://www.myworkday.com/External/activate/generic-fixture-token">Verify</a>' }];
        return messages;
      };
      const attempt = await scenario(name, host, "silent-quiet", { clock: virtualClock().clock }, (page) => { tab = page; });
      if (reads !== 1) failures.push(`${name}: expected one mailbox read, got ${reads}`);
      const entry = getWorkdayAccount(file, host);
      const activationCount = [...activationAttempts.values()].reduce((sum, count) => sum + count, 0) - attemptsBefore;
      const expectedClicks = kind === "found" ? "Create Account,Sign In,Sign In" : "Create Account,Sign In";
      if (accountSubmits.get(host)?.join(",") !== expectedClicks) failures.push(`${name}: unexpected account submit sequence`);
      if (activationCount !== (kind === "found" || kind === "navigation" ? 1 : 0)) failures.push(`${name}: unexpected verification navigation count`);
      if (kind === "found") {
        if (attempt.result !== "signed-in" || entry?.account !== "created" || entry.hold || !(await storedAccount(attempt.tab))?.verified) {
          failures.push(`${name}: matching link did not recover the account`);
        }
        await opensFlow(name, attempt.page);
      } else {
        held(name, attempt, kind === "navigation" ? "verification page could not be opened" : "the sign-in after it stopped");
        if (entry?.account !== "pending" || entry.hold?.kind !== "unexpected") failures.push(`${name}: pending account did not retain an unexpected hold`);
        if (kind === "navigation") {
          const token = (await storedAccount(attempt.tab))?.token;
          if (!token || [attempt.error?.message, entry?.hold?.reason, ...events(), ...captured].some((line) => line?.includes(token))) {
            failures.push(`${name}: verification token privacy check failed`);
          }
        }
      }
    }
    mail = async () => [];

    // No answer within 60 seconds and no account: the one sign-in fails, so the host is held as interrupted.
    const lostHost = "fixture-lost.wd1.myworkdayjobs.com";
    const lost = await scenario("lost", lostHost, "lost", { clock: virtualClock().clock });
    held("lost", lost, "60 seconds");
    held("lost", lost, "did not work");
    const lostHold = getWorkdayAccount(file, lostHost)?.hold;
    if (lostHold?.kind !== "interrupted") failures.push("lost: the hold is not interrupted");
    for (const diagnostic of ["no same-host request observed", "no page transition observed"]) {
      held("lost", lost, diagnostic);
      if (!lostHold?.reason.includes(diagnostic)) failures.push(`lost: the persisted hold does not mention "${diagnostic}"`);
    }
    const lostState = await fixtureState(lost.tab);
    if (lostState.signIns !== 1 || lostState.creates !== 1) failures.push(`lost: ${lostState.signIns} sign-ins and ${lostState.creates} creates`);

    // An error banner after the create submit: held with Workday's own text.
    const bannerHost = "fixture-banner.wd1.myworkdayjobs.com";
    const banner = await scenario("banner", bannerHost, "banner");
    held("banner", banner, "Try again later");
    if (getWorkdayAccount(file, bannerHost)?.hold?.kind !== "unexpected") failures.push("banner: the hold is not unexpected");

    // A text-message code: held as an unexpected step.
    const smsHost = "fixture-sms.wd1.myworkdayjobs.com";
    const sms = await scenario("sms", smsHost, "sms");
    held("sms", sms, "text-message");
    if (getWorkdayAccount(file, smsHost)?.hold?.kind !== "unexpected") failures.push("sms: the hold is not unexpected");

    // No password anywhere it must not be.
    const passwords = Object.values(readWorkdayAccounts(file)).map((entry) => entry.password).filter((value): value is string => Boolean(value));
    if (passwords.length < 5) failures.push(`expected at least 5 saved passwords, found ${passwords.length}`);
    const rows = JSON.stringify(["application_events", "browser_sessions", "browser_runs"].map((table) => database.prepare(`SELECT * FROM ${table}`).all()));
    for (const password of passwords) {
      if (rows.includes(password)) failures.push("a password reached the database");
      if (captured.some((line) => line.includes(password))) failures.push("a password reached the console");
      if (caughtMessages.some((message) => message.includes(password))) failures.push("a password reached an error message");
    }
    database.close();
    await context.close();
  } finally {
    Object.assign(console, originals);
    await browser.close();
    if (basename(temp).startsWith(PREFIX)) rmSync(temp, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`WORKDAY_ACCOUNT_RUN_REPORT {"status":"failed","failures":${JSON.stringify(failures)}}`);
    process.exit(1);
  }
  console.log(`WORKDAY_ACCOUNT_RUN_REPORT {"status":"passed","scenarios":28}`);
}

main().catch((error) => {
  console.error(`WORKDAY_ACCOUNT_RUN_REPORT {"status":"failed","failures":${JSON.stringify([error instanceof Error ? error.message : String(error)])}}`);
  process.exit(1);
});
