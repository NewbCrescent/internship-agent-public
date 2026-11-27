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
 * create goes to the verification email too (quiet). An HTML-only
 * verification email that shows its link only as text, not in an href (the
 * real email's structure), is found and opened too (html-text-link). A sign-in form whose
 * click filter is labelled "Submit" (submit-label, as rockwellautomation.wd1
 * draws it) is clicked through the filter over the form's own submit button
 * and signs in. Every account submit is clicked no sooner than one second
 * after its form appears (the candidate's choice, 2026-11-24): under the
 * fixture's dwell mode, which drops a submit clicked under 500 ms after its
 * button mounts as Workday's sign-in widget does, the account is created and
 * the sign-in drawn right after it signs in (dwell). Workday's generic sign-in
 * failure ("…or your account might be locked") is a refused sign-in, not a
 * lockout: with a pending saved password the agent submits the create form
 * once with it and never signs in twice in a call (signed in; created or
 * verified, then held for a later pass; "already exists" held), a saved
 * created account is held as a refused password, and a real lockout message
 * still holds as locked (pending-generic, pending-locked, created-generic,
 * pending-generic-exists, pending-generic-later, pending-generic-verify).
 * Workday's create handler sends tenants that verify emails to the site's
 * /login, which on nvidia.wd5 shows only the email-method chooser: that
 * chooser after a create counts as created, the generic refusal of the
 * unverified account's sign-in goes to the verification email, a pending
 * account refused at sign-in reads the mailbox once before any second create
 * (opening the link holds the host for a later pass), and a refused sign-in
 * on a pass that retries a verify-email hold reads the mailbox again
 * (login-redirect, login-redirect-pending, login-redirect-late).
 * A created account whose verification email never comes waits after the second empty mailbox read and is held as
 * interrupted after the third, with no password typed on later passes, and after a link that no longer verifies is
 * opened, a sign-in that still asks to verify holds as interrupted and a refused one as a refused password naming the
 * opened link (no-email-waits, no-email-stops, link-unverified, link-refused).
 * Never reads process.env for accounts or Gmail.
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
  putWorkdayAccount,
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
/** The password an earlier run saved for a seeded entry (meets the fixture's create rule). */
const SEEDED_PASSWORD = "Pending-Pass-1234!";
const PASSWORD_RULE = /^(?=.*[A-HJ-NP-Z])(?=.*[a-km-z])(?=.*[2-9])(?=.*[!@#$%^&*])[A-HJ-NP-Za-km-z2-9!@#$%^&*]{16}$/;

type FixtureAccount = { honeypotTyped: boolean; termsChecked: boolean; creates: number; signIns: number; emailMethodClicks: number; headerClicks: number; ignoredSubmits: number; submitDelays: number[] };

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
    // An entry an earlier run left: a saved password, account "pending" (create never confirmed) or "created".
    const seedAccount = (host: string, account: "pending" | "created") => {
      const stamp = new Date(Date.now() - 3_600_000).toISOString();
      putWorkdayAccount(file, { host, email: EMAIL, password: SEEDED_PASSWORD, account, hold: null, createdAt: stamp, updatedAt: stamp });
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

    // The sign-in form's click filter labelled "Submit", not "Sign In", as rockwellautomation.wd1 drew it
    // (read-only capture, 2026-11-24): the click goes to the filter in the noCaptchaWrapper over the form's own
    // submit button, and the account signs in. Real markup draws the form 800 ms late, so the real clock is used.
    const submitLabelHost = "fixture-submit-label.wd1.myworkdayjobs.com";
    const submitLabel = await scenario("submit-label", submitLabelHost, "signin-after&markup=real&filter=submit");
    if (submitLabel.result !== "signed-in") failures.push(`submit-label: expected "signed-in", got ${submitLabel.result ?? submitLabel.error?.message}`);
    const submitLabelState = await fixtureState(submitLabel.tab);
    if (submitLabelState.creates !== 1 || submitLabelState.signIns !== 1) {
      failures.push(`submit-label: ${submitLabelState.creates} creates and ${submitLabelState.signIns} sign-ins`);
    }
    if (submitLabelState.honeypotTyped) failures.push("submit-label: the robot honeypot was typed in");
    await opensFlow("submit-label", submitLabel.page);

    // Workday's sign-in widget drops an account submit clicked under 500 ms after its button mounts (dwell=1).
    // The create, and the sign-in form Workday draws right after it, are each clicked no sooner than one second
    // after their form appears (the candidate's choice, 2026-11-24), so the account is created and signs in.
    const dwellHost = "fixture-dwell.wd1.myworkdayjobs.com";
    const dwell = await scenario("dwell", dwellHost, "signin-after&dwell=1", { clock: virtualClock().clock });
    if (dwell.result !== "signed-in") failures.push(`dwell: expected "signed-in", got ${dwell.result ?? dwell.error?.message}`);
    const dwellState = await fixtureState(dwell.tab);
    if (dwellState.ignoredSubmits !== 0) failures.push(`dwell: ${dwellState.ignoredSubmits} submits dropped as too early (delays ${dwellState.submitDelays.join(", ")} ms)`);
    if (dwellState.creates !== 1 || dwellState.signIns !== 1) failures.push(`dwell: ${dwellState.creates} creates and ${dwellState.signIns} sign-ins`);
    if (dwellState.submitDelays.length !== 2 || dwellState.submitDelays.some((delay) => delay < 950)) {
      failures.push(`dwell: submit delays ${dwellState.submitDelays.join(", ")} ms, expected two of at least 950`);
    }
    if (dwellState.honeypotTyped) failures.push("dwell: the robot honeypot was typed in");
    if (!events().includes(`Workday ${dwellHost}: account created with your email; the password is saved locally.`)) failures.push("dwell: no account-created event");
    await opensFlow("dwell", dwell.page);

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

    // Workday's real verification email is HTML-only and shows its activation link only as text
    // (no href holds it): the link is still found and opened, and the agent signs in.
    const htmlTextHost = "fixture-html-link.wd1.myworkdayjobs.com";
    let htmlTextTab: Page | null = null;
    mail = async (): Promise<MailMessage[]> => {
      const token = htmlTextTab ? (await storedAccount(htmlTextTab))?.token ?? "" : "";
      return [{
        from: "Fixture Careers <fixture@otp.workday.com>", subject: "Verify your candidate account", receivedAt: new Date(), text: "",
        html: `<table><tr><td><p>Please verify your candidate account.</p><p>https://${htmlTextHost}/External/activate/${token}</p><p><a href="http://www.workday.com">Workday</a></p></td></tr></table>`
      }];
    };
    const htmlText = await scenario("html-text-link", htmlTextHost, "notice", { clock: virtualClock().clock }, (tab) => { htmlTextTab = tab; });
    if (htmlText.result !== "signed-in" && htmlText.result !== "created") failures.push(`html-text-link: expected a sign-in, got ${htmlText.result ?? htmlText.error?.message}`);
    if (!events().includes(`Workday ${htmlTextHost}: verification email found and opened.`)) failures.push("html-text-link: no verification event");
    if (!(await storedAccount(htmlText.tab))?.verified) failures.push("html-text-link: the fixture account was not verified");
    await opensFlow("html-text-link", htmlText.page);
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

    // Workday's generic sign-in failure (11 tenants, 2026-11-25) with a pending saved password: a refused
    // sign-in, not a lockout. The agent submits the create form once with the saved password and signs in.
    const pendingGenericHost = "fixture-pending-generic.wd1.myworkdayjobs.com";
    seedAccount(pendingGenericHost, "pending");
    const pendingGeneric = await scenario("pending-generic", pendingGenericHost, "create&signin-error=generic");
    if (pendingGeneric.result !== "created") failures.push(`pending-generic: expected "created", got ${pendingGeneric.result ?? pendingGeneric.error?.message}`);
    const pendingGenericState = await fixtureState(pendingGeneric.tab);
    if (pendingGenericState.signIns !== 1 || pendingGenericState.creates !== 1) {
      failures.push(`pending-generic: ${pendingGenericState.signIns} sign-ins and ${pendingGenericState.creates} creates`);
    }
    if (accountSubmits.get(pendingGenericHost)?.join(",") !== "Sign In,Create Account") failures.push(`pending-generic: account submits ${accountSubmits.get(pendingGenericHost)?.join(",")}`);
    if (savedBeforeSubmit.get(pendingGenericHost) !== true) failures.push("pending-generic: the password was not saved before the create submit");
    const pendingGenericEntry = getWorkdayAccount(file, pendingGenericHost);
    if (pendingGenericEntry?.account !== "created" || pendingGenericEntry.hold !== null || pendingGenericEntry.password !== SEEDED_PASSWORD) {
      failures.push(`pending-generic: entry is ${pendingGenericEntry?.account} with hold ${pendingGenericEntry?.hold?.kind}`);
    }
    if ((await storedAccount(pendingGeneric.tab))?.password !== SEEDED_PASSWORD) failures.push("pending-generic: Workday holds a different password than the saved one");
    if (getBrowserSession(database, `workday:${pendingGenericHost}/External`)?.status !== "connected") failures.push("pending-generic: the session is not connected");
    if (!events().includes(`Workday ${pendingGenericHost}: Workday did not accept the saved password for the account an earlier run started to create, so the agent submits the create-account form once with it.`)) {
      failures.push("pending-generic: no create-after-refused-sign-in event");
    }
    if (!events().includes(`Workday ${pendingGenericHost}: account created with your email; the password is saved locally.`)) failures.push("pending-generic: no account-created event");
    if (pendingGenericState.honeypotTyped) failures.push("pending-generic: the robot honeypot was typed in");
    await opensFlow("pending-generic", pendingGeneric.page);

    // A real lockout message is still a lockout: held as locked, never retried, and no create.
    const pendingLockedHost = "fixture-pending-locked.wd1.myworkdayjobs.com";
    seedAccount(pendingLockedHost, "pending");
    const pendingLocked = await scenario("pending-locked", pendingLockedHost, "create&signin-error=locked");
    held("pending-locked", pendingLocked, "locked or disabled");
    const pendingLockedEntry = getWorkdayAccount(file, pendingLockedHost);
    if (pendingLockedEntry?.hold?.kind !== "locked" || pendingLockedEntry.account !== "pending") {
      failures.push(`pending-locked: entry is ${pendingLockedEntry?.account} with hold ${pendingLockedEntry?.hold?.kind}`);
    }
    const pendingLockedState = await fixtureState(pendingLocked.tab);
    if (pendingLockedState.signIns !== 1 || pendingLockedState.creates !== 0) {
      failures.push(`pending-locked: ${pendingLockedState.signIns} sign-ins and ${pendingLockedState.creates} creates`);
    }
    if (workdayAccountWait(gate, pendingLockedHost, EMAIL) === null) failures.push("pending-locked: the gate does not hold");
    if (workdayAccountWait(gate, pendingLockedHost, EMAIL, new Date(Date.now() + 25 * 3_600_000)) === null) failures.push("pending-locked: the gate opens after 25 hours");

    // The generic message for an account the agent saved as created: a refused password, not a lockout.
    const createdGenericHost = "fixture-created-generic.wd1.myworkdayjobs.com";
    seedAccount(createdGenericHost, "created");
    const createdGeneric = await scenario("created-generic", createdGenericHost, "create&signin-error=generic");
    held("created-generic", createdGeneric, "refused the saved password");
    if (getWorkdayAccount(file, createdGenericHost)?.hold?.kind !== "wrong-password") failures.push("created-generic: the hold is not wrong-password");
    const createdGenericState = await fixtureState(createdGeneric.tab);
    if (createdGenericState.signIns !== 1 || createdGenericState.creates !== 0) {
      failures.push(`created-generic: ${createdGenericState.signIns} sign-ins and ${createdGenericState.creates} creates`);
    }

    // The generic message, then "already exists" on the one create: held, account refused, never reset.
    const pendingExistsHost = "fixture-pending-generic-exists.wd1.myworkdayjobs.com";
    seedAccount(pendingExistsHost, "pending");
    const pendingExists = await scenario("pending-generic-exists", pendingExistsHost, "exists&signin-error=generic");
    held("pending-generic-exists", pendingExists, "already exists");
    const pendingExistsEntry = getWorkdayAccount(file, pendingExistsHost);
    if (pendingExistsEntry?.hold?.kind !== "exists" || pendingExistsEntry.account !== "refused") {
      failures.push(`pending-generic-exists: entry is ${pendingExistsEntry?.account} with hold ${pendingExistsEntry?.hold?.kind}`);
    }
    const pendingExistsState = await fixtureState(pendingExists.tab);
    if (pendingExistsState.signIns !== 1 || pendingExistsState.creates !== 1) {
      failures.push(`pending-generic-exists: ${pendingExistsState.signIns} sign-ins and ${pendingExistsState.creates} creates`);
    }

    // The generic message, then a create that shows the sign-in form: no second sign-in in this call;
    // the account is saved as created and the host waits an hour for a later pass.
    const pendingLaterHost = "fixture-pending-generic-later.wd1.myworkdayjobs.com";
    seedAccount(pendingLaterHost, "pending");
    const pendingLater = await scenario("pending-generic-later", pendingLaterHost, "signin-after&signin-error=generic");
    held("pending-generic-later", pendingLater, "signs in on a later pass");
    const pendingLaterEntry = getWorkdayAccount(file, pendingLaterHost);
    if (pendingLaterEntry?.account !== "created" || pendingLaterEntry.hold?.kind !== "verify-email" || pendingLaterEntry.hold.attempts !== 1) {
      failures.push(`pending-generic-later: entry is ${pendingLaterEntry?.account} with hold ${pendingLaterEntry?.hold?.kind}`);
    }
    const pendingLaterState = await fixtureState(pendingLater.tab);
    if (pendingLaterState.signIns !== 1 || pendingLaterState.creates !== 1) {
      failures.push(`pending-generic-later: ${pendingLaterState.signIns} sign-ins and ${pendingLaterState.creates} creates`);
    }
    if (workdayAccountWait(gate, pendingLaterHost, EMAIL) === null) failures.push("pending-generic-later: the gate does not hold now");
    if (workdayAccountWait(gate, pendingLaterHost, EMAIL, new Date(Date.now() + 61 * 60_000)) !== null) failures.push("pending-generic-later: the gate still holds after an hour");

    // The generic message, then a create that asks to verify the email: the link is opened, and the
    // agent does not sign in again in this call.
    const pendingVerifyHost = "fixture-pending-generic-verify.wd1.myworkdayjobs.com";
    seedAccount(pendingVerifyHost, "pending");
    let pendingVerifyTab: Page | null = null;
    // No verification email exists before the create (the agent reads the mailbox once before submitting it).
    mail = async () => (pendingVerifyTab && (await storedAccount(pendingVerifyTab))?.token ? linkFor(pendingVerifyHost, () => pendingVerifyTab)() : []);
    const pendingVerify = await scenario("pending-generic-verify", pendingVerifyHost, "verify&signin-error=generic", undefined, (tab) => { pendingVerifyTab = tab; });
    held("pending-generic-verify", pendingVerify, "signs in on a later pass");
    const pendingVerifyEntry = getWorkdayAccount(file, pendingVerifyHost);
    if (pendingVerifyEntry?.account !== "created" || pendingVerifyEntry.hold?.kind !== "verify-email") {
      failures.push(`pending-generic-verify: entry is ${pendingVerifyEntry?.account} with hold ${pendingVerifyEntry?.hold?.kind}`);
    }
    if (!events().includes(`Workday ${pendingVerifyHost}: verification email found and opened.`)) failures.push("pending-generic-verify: no verification event");
    if (!(await storedAccount(pendingVerify.tab))?.verified) failures.push("pending-generic-verify: the fixture account was not verified");
    // The flow reloads the tab after opening the link (resetting the fixture's counters), so the submits are
    // counted across pages: one sign-in, one create, and no sign-in after the verification.
    if (accountSubmits.get(pendingVerifyHost)?.join(",") !== "Sign In,Create Account") {
      failures.push(`pending-generic-verify: account submits ${accountSubmits.get(pendingVerifyHost)?.join(",")}`);
    }
    mail = async () => [];

    // nvidia.wd5's flow (read-only captures and Workday's public create handler, 2026-11-25): the account step opens on
    // the email-method chooser; a create that succeeds sends the page to the site's /login, which shows only the chooser
    // since the site verifies emails; and Workday refuses the unverified account's sign-in with its generic failure. The
    // chooser counts as created at once, and the refused sign-in goes to the verification email.
    const redirectHost = "fixture-login-redirect.wd1.myworkdayjobs.com";
    let redirectTab: Page | null = null;
    mail = linkFor(redirectHost, () => redirectTab);
    const redirectClock = virtualClock(0);
    const redirect = await scenario("login-redirect", redirectHost, "login-redirect", { clock: redirectClock.clock }, (tab) => { redirectTab = tab; });
    if (redirect.result !== "signed-in") failures.push(`login-redirect: expected "signed-in", got ${redirect.result ?? redirect.error?.message}`);
    if (redirectClock.clock.now() >= 60_000) failures.push(`login-redirect: the agent waited ${redirectClock.clock.now()} virtual ms`);
    if (savedBeforeSubmit.get(redirectHost) !== true) failures.push("login-redirect: the password was not saved before the create submit");
    if (accountSubmits.get(redirectHost)?.join(",") !== "Create Account,Sign In,Sign In") failures.push(`login-redirect: account submits ${accountSubmits.get(redirectHost)?.join(",")}`);
    const redirectEntry = getWorkdayAccount(file, redirectHost);
    if (redirectEntry?.account !== "created" || redirectEntry.hold !== null) failures.push(`login-redirect: entry is ${redirectEntry?.account} with hold ${redirectEntry?.hold?.kind}`);
    for (const text of [
      `Workday ${redirectHost}: account created with your email; the password is saved locally.`,
      `Workday ${redirectHost}: Workday refused the sign-in right after the account was created; the agent looks for the verification email.`,
      `Workday ${redirectHost}: verification email found and opened.`
    ]) if (!events().includes(text)) failures.push(`login-redirect: no event "${text}"`);
    if (!(await storedAccount(redirect.tab))?.verified) failures.push("login-redirect: the fixture account was not verified");
    await opensFlow("login-redirect", redirect.page);

    // The same tenant after an earlier create was read as no answer (nvidia.wd5's state, 2026-11-25): the saved pending
    // password is refused because the email is not verified. One mailbox read finds the verification email; the link is
    // opened, the account saved as created, and the host waits for a later pass, with no second create submit.
    const redirectPendingHost = "fixture-login-redirect-pending.wd1.myworkdayjobs.com";
    const seededToken = "seededfixturetoken";
    seedAccount(redirectPendingHost, "pending");
    const seedTab = await context.newPage();
    await seedTab.goto(urlFor(redirectPendingHost, "login-redirect"));
    await seedTab.evaluate(({ email, password, token }) => {
      localStorage.setItem("fixture-workday-accounts", JSON.stringify({ [email]: { password, verified: false, token } }));
    }, { email: EMAIL, password: SEEDED_PASSWORD, token: seededToken });
    await seedTab.close();
    let pendingReads = 0;
    mail = async () => {
      pendingReads += 1;
      return [{
        from: "Fixture Verify <fixture-login-redirect-pending@myworkday.com>", subject: "Verify your candidate account", receivedAt: new Date(), text: "",
        html: `<a href="https://${redirectPendingHost}/External/activate/${seededToken}">Verify</a>`
      }];
    };
    const redirectPending = await scenario("login-redirect-pending", redirectPendingHost, "login-redirect", { clock: virtualClock(0).clock });
    held("login-redirect-pending", redirectPending, "signs in on a later pass");
    if (pendingReads !== 1) failures.push(`login-redirect-pending: expected one mailbox read, got ${pendingReads}`);
    const redirectPendingEntry = getWorkdayAccount(file, redirectPendingHost);
    if (redirectPendingEntry?.account !== "created" || redirectPendingEntry.hold?.kind !== "verify-email") {
      failures.push(`login-redirect-pending: entry is ${redirectPendingEntry?.account} with hold ${redirectPendingEntry?.hold?.kind}`);
    }
    if (accountSubmits.get(redirectPendingHost)?.join(",") !== "Sign In") failures.push(`login-redirect-pending: account submits ${accountSubmits.get(redirectPendingHost)?.join(",")}`);
    if (!(await storedAccount(redirectPending.tab))?.verified) failures.push("login-redirect-pending: the fixture account was not verified");
    for (const text of [
      `Workday ${redirectPendingHost}: Workday did not accept the saved password for the account an earlier run started to create; the agent looks for that account's verification email first.`,
      `Workday ${redirectPendingHost}: verification email found and opened.`
    ]) if (!events().includes(text)) failures.push(`login-redirect-pending: no event "${text}"`);
    if (workdayAccountWait(gate, redirectPendingHost, EMAIL) === null) failures.push("login-redirect-pending: the gate does not hold now");
    if (workdayAccountWait(gate, redirectPendingHost, EMAIL, new Date(Date.now() + 61 * 60_000)) !== null) failures.push("login-redirect-pending: the gate still holds after an hour");
    // The later pass signs in with the saved password.
    mail = async () => [];
    const redirectPendingLater = await scenario("login-redirect-pending later pass", redirectPendingHost, "login-redirect", { clock: virtualClock(0).clock });
    if (redirectPendingLater.result !== "signed-in") failures.push(`login-redirect-pending later pass: expected "signed-in", got ${redirectPendingLater.result ?? redirectPendingLater.error?.message}`);
    if (getWorkdayAccount(file, redirectPendingHost)?.hold !== null) failures.push("login-redirect-pending later pass: the hold was not cleared");
    if (accountSubmits.get(redirectPendingHost)?.join(",") !== "Sign In,Sign In") failures.push(`login-redirect-pending later pass: account submits ${accountSubmits.get(redirectPendingHost)?.join(",")}`);
    await opensFlow("login-redirect-pending later pass", redirectPendingLater.page);

    // The verification email arrives after the agent's mailbox window (synthetic): the host waits as verify-email, and on
    // the later pass the refused sign-in reads the mailbox again instead of holding the password as refused.
    const redirectLateHost = "fixture-login-redirect-late.wd1.myworkdayjobs.com";
    mail = async () => [];
    const redirectLateFirst = await scenario("login-redirect-late", redirectLateHost, "login-redirect", { clock: virtualClock(0).clock });
    held("login-redirect-late", redirectLateFirst, "verification email not found");
    const redirectLateEntry = getWorkdayAccount(file, redirectLateHost);
    if (redirectLateEntry?.account !== "created" || redirectLateEntry.hold?.kind !== "verify-email") {
      failures.push(`login-redirect-late: entry is ${redirectLateEntry?.account} with hold ${redirectLateEntry?.hold?.kind}`);
    }
    mail = linkFor(redirectLateHost, () => redirectLateFirst.tab);
    const redirectLate = await scenario("login-redirect-late later pass", redirectLateHost, "login-redirect", { clock: virtualClock(0).clock });
    if (redirectLate.result !== "signed-in") failures.push(`login-redirect-late later pass: expected "signed-in", got ${redirectLate.result ?? redirectLate.error?.message}`);
    if (!events().includes(`Workday ${redirectLateHost}: Workday refused the sign-in while the account waits for email verification; the agent looks for the verification email.`)) {
      failures.push("login-redirect-late later pass: no look-for-the-email event");
    }
    if (!(await storedAccount(redirectLate.tab))?.verified) failures.push("login-redirect-late later pass: the fixture account was not verified");
    if (getWorkdayAccount(file, redirectLateHost)?.hold !== null) failures.push("login-redirect-late later pass: the hold was not cleared");
    if (accountSubmits.get(redirectLateHost)?.join(",") !== "Create Account,Sign In,Sign In,Sign In") failures.push(`login-redirect-late: account submits ${accountSubmits.get(redirectLateHost)?.join(",")}`);
    await opensFlow("login-redirect-late later pass", redirectLate.page);
    mail = async () => [];

    // A created account whose verification email never comes (three real hosts, 2026-11-26): each pass's refused
    // sign-in reads the mailbox again, the second empty read still waits, and the third holds the host as interrupted,
    // after which no later pass types the password again.
    const verifyHold = (host: string, attempts: number) => {
      putWorkdayAccount(file, {
        ...getWorkdayAccount(file, host)!,
        hold: { kind: "verify-email", reason: `Workday ${host}: verification email not found within 1 minute; the agent checks again on a later pass.`, at: new Date(Date.now() - 3_600_000).toISOString(), attempts }
      });
    };
    const noEmailWaitsHost = "fixture-no-email-waits.wd1.myworkdayjobs.com";
    seedAccount(noEmailWaitsHost, "created");
    verifyHold(noEmailWaitsHost, 1);
    mail = async () => [];
    const noEmailWaits = await scenario("no-email-waits", noEmailWaitsHost, "create&signin-error=generic");
    held("no-email-waits", noEmailWaits, "verification email not found");
    const noEmailWaitsEntry = getWorkdayAccount(file, noEmailWaitsHost);
    if (noEmailWaitsEntry?.account !== "created" || noEmailWaitsEntry.hold?.kind !== "verify-email" || noEmailWaitsEntry.hold.attempts !== 2) {
      failures.push(`no-email-waits: entry is ${noEmailWaitsEntry?.account} with hold ${noEmailWaitsEntry?.hold?.kind} (${noEmailWaitsEntry?.hold?.attempts})`);
    }
    mail = async () => [];

    const noEmailStopsHost = "fixture-no-email-stops.wd1.myworkdayjobs.com";
    seedAccount(noEmailStopsHost, "created");
    verifyHold(noEmailStopsHost, 2);
    mail = async () => [];
    const noEmailStops = await scenario("no-email-stops", noEmailStopsHost, "create&signin-error=generic");
    held("no-email-stops", noEmailStops, "never resets passwords");
    const noEmailStopsEntry = getWorkdayAccount(file, noEmailStopsHost);
    if (noEmailStopsEntry?.account !== "created" || noEmailStopsEntry.hold?.kind !== "interrupted" || noEmailStopsEntry.password !== SEEDED_PASSWORD) {
      failures.push(`no-email-stops: entry is ${noEmailStopsEntry?.account} with hold ${noEmailStopsEntry?.hold?.kind}`);
    }
    const noEmailStopsState = await fixtureState(noEmailStops.tab);
    if (noEmailStopsState.signIns !== 1 || noEmailStopsState.creates !== 0) {
      failures.push(`no-email-stops: ${noEmailStopsState.signIns} sign-ins and ${noEmailStopsState.creates} creates`);
    }
    if (!events().includes(`Workday ${noEmailStopsHost}: Workday refused the sign-in while the account waits for email verification; the agent looks for the verification email.`)) {
      failures.push("no-email-stops: no look-for-the-email event");
    }
    const noEmailStopsLater = await scenario("no-email-stops later pass", noEmailStopsHost, "create&signin-error=generic");
    const noEmailStopsReason = getWorkdayAccount(file, noEmailStopsHost)?.hold?.reason;
    if (!(noEmailStopsLater.error instanceof WorkdayAccountHeld) || noEmailStopsLater.error.message !== noEmailStopsReason) {
      failures.push(`no-email-stops later pass: expected the stored hold, got ${noEmailStopsLater.result ?? noEmailStopsLater.error?.message}`);
    }
    const noEmailStopsLaterState = await fixtureState(noEmailStopsLater.tab);
    if (noEmailStopsLaterState.signIns !== 0 || noEmailStopsLaterState.creates !== 0) {
      failures.push(`no-email-stops later pass: ${noEmailStopsLaterState.signIns} sign-ins and ${noEmailStopsLaterState.creates} creates`);
    }
    if (workdayAccountWait(gate, noEmailStopsHost, EMAIL, new Date(Date.now() + 25 * 3_600_000)) === null) failures.push("no-email-stops: the gate opens after 25 hours");
    mail = async () => [];

    // A verification link that no longer verifies the account (synthetic stale token; no real expired-link page was
    // captured): after opening it, a sign-in that still asks to verify holds as interrupted and the link is not reopened,
    // and a refused sign-in holds as a refused password whose reason names the opened link.
    const staleLink = (host: string) => async (): Promise<MailMessage[]> => [{
      from: "Fixture Careers <fixture@otp.workday.com>", subject: "Verify your candidate account", receivedAt: new Date(), text: "",
      html: `<table><tr><td><p>Please verify your candidate account.</p><p>https://${host}/External/activate/stalefixturetoken</p></td></tr></table>`
    }];
    const linkUnverifiedHost = "fixture-link-unverified.wd1.myworkdayjobs.com";
    mail = staleLink(linkUnverifiedHost);
    const linkUnverified = await scenario("link-unverified", linkUnverifiedHost, "notice", { clock: virtualClock().clock });
    held("link-unverified", linkUnverified, "the link may have expired; the agent does not open it again");
    if (getWorkdayAccount(file, linkUnverifiedHost)?.hold?.kind !== "interrupted") failures.push(`link-unverified: the hold is ${getWorkdayAccount(file, linkUnverifiedHost)?.hold?.kind}`);
    if (!events().includes(`Workday ${linkUnverifiedHost}: verification email found and opened.`)) failures.push("link-unverified: no verification event");
    if ((await storedAccount(linkUnverified.tab))?.verified) failures.push("link-unverified: the fixture account was verified by a stale link");
    mail = async () => [];

    const linkRefusedHost = "fixture-link-refused.wd1.myworkdayjobs.com";
    mail = staleLink(linkRefusedHost);
    const linkRefused = await scenario("link-refused", linkRefusedHost, "login-redirect", { clock: virtualClock(0).clock });
    held("link-refused", linkRefused, "after the agent opened the verification link");
    if (getWorkdayAccount(file, linkRefusedHost)?.hold?.kind !== "wrong-password") failures.push(`link-refused: the hold is ${getWorkdayAccount(file, linkRefusedHost)?.hold?.kind}`);
    mail = async () => [];

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
  console.log(`WORKDAY_ACCOUNT_RUN_REPORT {"status":"passed","scenarios":44}`);
}

main().catch((error) => {
  console.error(`WORKDAY_ACCOUNT_RUN_REPORT {"status":"failed","failures":${JSON.stringify([error instanceof Error ? error.message : String(error)])}}`);
  process.exit(1);
});
