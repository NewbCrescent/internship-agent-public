/**
 * Track 42 (2026-11-25): stop captures and run traces in real Chromium,
 * against pages a server owned by this script serves on 127.0.0.1 (port 0),
 * with a temporary data directory removed at the end; no other network.
 * Proves:
 * (A) the stop-region reader (stop-evidence.ts readStopRegionIn, through the
 *     Playwright adapter's `stopRegion`) keeps a field's form-field container,
 *     a labelled section, and for a page-level stop the main region with its
 *     iframes and Apply-like controls, query-stripped; never an input's typed
 *     or default value, a hidden token, textarea or contenteditable text, an
 *     email, or a long digit run; marks a lingering hidden step `ia-hidden`;
 *     cuts a 3,000-row page at 12,000 characters; and reads without a click,
 *     focus, input, change, focus move, or DOM mutation;
 * (B) a run trace with the default options (run-trace.ts RUN_TRACE_OPTIONS,
 *     the candidate's choice on 2026-11-26: the film strip and the actions, no
 *     DOM, aria, or per-action screen snapshots) of a page whose server sets a
 *     cookie, whose script sets one and sends an Authorization header, and
 *     whose API answers with a cookie and a token, holds none of those values
 *     and no network record, passes the fail-closed check, keeps the film
 *     strip (screencast frames) but no per-action screenshot (no
 *     `screenshots/` entry, no `screenshot` event), and is saved mode 600 in a
 *     mode 700 folder with no parts left;
 * (B2) the same flow in snapshot mode (startRunTrace `snapshots: true`,
 *     RUN_TRACE_SNAPSHOT_OPTIONS, what INTERNSHIP_AGENT_TRACE_SNAPSHOTS=1
 *     turns on) does record the per-action screenshots, and still holds none
 *     of those values and no network record and passes the fail-closed check;
 * (C) the same flow traced with `snapshots: true` does hold one of them, and
 *     the check calls it "network-found" (the check detects what (B) avoids);
 * (D) a password typed inside a wrapped account method is in neither saved
 *     part, while the same sequence unwrapped records it;
 * (E) after a wrapped security-code step nothing more is recorded;
 * (F) a saved value found in the trace drops it ("secret-found"), unknown
 *     saved values drop it ("secrets-unknown"), and a clean end keeps nothing;
 * (G) pruning: traces older than 14 days, the oldest over the size cap, parts
 *     folders older than a day, and Playwright's intermediate files older than
 *     a day (by each file's own time) go, fresh files stay; the zip reader
 *     reads stored and deflated entries and refuses a truncated file;
 * (H) informational: the time and size a default-mode and a snapshot-mode
 *     trace add to the Handshake fixture fill and the Workday fixture's first
 *     walk, medians of 3 in fresh contexts (never fails on the numbers);
 * (I) git ignores run traces and stop captures under the real profile;
 * (J) traceSnapshotsWanted reads INTERNSHIP_AGENT_TRACE_SNAPSHOTS (exactly
 *     "1") and the optional exact-host list INTERNSHIP_AGENT_TRACE_SNAPSHOT_HOSTS.
 *
 * Usage: xvfb-run -a pnpm test:browser:stop-evidence
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import {
  applyDecisions,
  captureStopEvidence,
  checkRunTraceZip,
  createPlaywrightPage,
  createWorkdayPage,
  planAutofill,
  pruneRunTraces,
  readZipEntries,
  recognizeCurrentForm,
  RUN_TRACE_OPTIONS,
  RUN_TRACE_SNAPSHOT_OPTIONS,
  startRunTrace,
  traceSnapshotsWanted,
  walkWorkdayApplication,
  wrapUntracedMethods,
  type RunTrace
} from "@internship-agent/browser";

const PREFIX = "internship-agent-stop-evidence-";

const STOP_PAGE = `<!doctype html><html><head><title>Stop fixture</title></head><body>
<main>
<h1>Apply for Robotics Intern</h1>
<p>Questions? Write to jordan@example.test or call 5551234567.</p>
<div data-automation-id="formField-city"><label for="city">City</label><input id="city" name="city" value="DEFAULT-CITY-1"><span class="hint">We email jordan@example.test or call 5551234567</span></div>
<input type="hidden" name="csrf" value="CSRF-TOKEN-1234">
<div class="field"><label for="essay">Essay</label><textarea id="essay" name="essay"></textarea></div>
<div class="field"><label for="rich">Cover note</label><div id="rich" contenteditable="true"></div></div>
<div class="field"><label for="size">Shirt size</label><select id="size" name="size"><option>S</option><option selected>M</option></select></div>
<a href="/start?token=QUERY-TOKEN-9">Apply now</a>
<iframe src="/frame?icims=1&amp;secret=FRAME-QUERY-4" title="Job application" name="icims_content_iframe" width="400" height="200"></iframe>
<div id="lingering" style="display:none"><input type="file" data-automation-id="file-upload-input-ref"></div>
<div role="group" aria-label="Work Experience"><h3>Work Experience</h3><label for="jobTitle">Job Title</label><input id="jobTitle" name="jobTitle"></div>
</main>
<script>
window.counts = { click: 0, focus: 0, input: 0, change: 0 };
for (const name of Object.keys(window.counts)) document.addEventListener(name, () => { window.counts[name] += 1; }, true);
</script>
</body></html>`;

const BIG_PAGE = `<!doctype html><html><body><main>${Array.from({ length: 3_000 }, (_, index) => `<div class="row"><span>Row ${index}</span><input name="r${index}"></div>`).join("")}</main></body></html>`;

const FORM_PAGE = `<!doctype html><html><head><title>Traced form</title></head><body>
<label for="name">Full name</label><input id="name" name="name">
<label for="password">Password</label><input id="password" type="password" name="password">
<label for="code">Code</label><input id="code" name="code">
<button id="go" type="button" onclick="document.getElementById('status').dataset.clicked = 'yes'">Continue</button>
<p id="status">waiting</p>
<script>
document.cookie = "ia_client=CLIENT-COOKIE-91b2; path=/";
fetch("/api/ping", { headers: { Authorization: "Bearer AUTH-TOKEN-5c8d" } })
  .then((response) => response.json())
  .then(() => { document.getElementById("status").textContent = "pinged"; });
</script>
</body></html>`;

const COOKIE_VALUES = ["COOKIE-VALUE-7f3a", "CLIENT-COOKIE-91b2", "AUTH-TOKEN-5c8d", "API-COOKIE-6d0f", "BODY-TOKEN-22e1"];

function serve(): Promise<Server> {
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/stop") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(STOP_PAGE);
    } else if (path === "/big") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(BIG_PAGE);
    } else if (path === "/form") {
      response.writeHead(200, { "content-type": "text/html", "set-cookie": "ia_session=COOKIE-VALUE-7f3a; HttpOnly; Path=/" });
      response.end(FORM_PAGE);
    } else if (path === "/api/ping") {
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "ia_api=API-COOKIE-6d0f; Path=/" });
      response.end(JSON.stringify({ token: "BODY-TOKEN-22e1" }));
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><p>Fixture</p>");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Every entry of every zip, inflated, as one text (binary entries included). */
function zipText(paths: string[]): string {
  return paths.map((path) => readZipEntries(readFileSync(path)).map((entry) => entry.data.toString("latin1")).join("\n")).join("\n");
}

function buildZip(files: Array<{ name: string; text: string; deflate: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.from(file.text, "utf8");
    const body = file.deflate ? deflateRawSync(data) : data;
    const name = Buffer.from(file.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const mode = (path: string) => statSync(path).mode & 0o777;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), PREFIX));
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const server = await serve();
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser: Browser = await chromium.launch();
  const traceDir = (name: string) => join(temp, "data", "applications", name, "run-traces");
  let overhead: Record<string, unknown> = {};
  try {
    // ---- (A) the stop-region reader ----
    {
      const context = await browser.newContext();
      const tab = await context.newPage();
      await tab.goto(`${origin}/stop?session=QUERY-SESSION-1`);
      await tab.fill("#city", "TYPED-CITY-7781");
      await tab.fill("#essay", "TYPED-ESSAY-5521");
      await tab.fill("#rich", "TYPED-RICH-3310");
      await tab.locator("body").click({ position: { x: 1, y: 1 } });
      await tab.evaluate(() => {
        const state = window as unknown as { counts: Record<string, number>; mutations: number; activeBefore: Element | null };
        for (const name of Object.keys(state.counts)) state.counts[name] = 0;
        state.mutations = 0;
        state.activeBefore = document.activeElement;
        new MutationObserver((records) => { state.mutations += records.length; })
          .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      });
      const page = createPlaywrightPage(tab);
      const field = await page.stopRegion!({ kind: "field", fieldId: "city", label: "City" });
      check(field.anchor === "id", `(A) field anchor ${field.anchor}`);
      check(field.html.includes('data-automation-id="formField-city"') && field.html.includes("City"), `(A) field region ${field.html.slice(0, 200)}`);
      check(field.html.includes("[email]") && field.html.includes("[number]"), "(A) field region shows no [email] or [number]");
      for (const value of ["TYPED-CITY-7781", "DEFAULT-CITY-1", "CSRF-TOKEN-1234", "jordan@example.test", "5551234567"]) check(!field.html.includes(value), `(A) field region holds ${value}`);
      check(field.frames.length === 0 && field.applyControls.length === 0, "(A) a field request listed frames or controls");

      const whole = await page.stopRegion!({ kind: "page" });
      check(whole.anchor === "main", `(A) page anchor ${whole.anchor}`);
      check(whole.frames.length === 1 && whole.frames[0]!.src === `${origin}/frame` && whole.frames[0]!.title === "Job application", `(A) frames ${JSON.stringify(whole.frames)}`);
      const apply = whole.applyControls.find((control) => control.text === "Apply now");
      check(apply?.href === `${origin}/start`, `(A) apply control ${JSON.stringify(whole.applyControls)}`);
      for (const value of ["TYPED-ESSAY-5521", "TYPED-RICH-3310", "QUERY-TOKEN-9", "FRAME-QUERY-4", "TYPED-CITY-7781", "DEFAULT-CITY-1", "CSRF-TOKEN-1234", "jordan@example.test", "5551234567"]) {
        check(!whole.html.includes(value) && !JSON.stringify(whole.frames).includes(value) && !JSON.stringify(whole.applyControls).includes(value), `(A) page region holds ${value}`);
      }
      check(/<div id="lingering"[^>]*ia-hidden=""/.test(whole.html), "(A) the hidden step is not marked ia-hidden");
      check(whole.html.includes("[text not kept]"), "(A) textarea or contenteditable text was not replaced");
      check(!/\bselected\b|\bvalue=/.test(whole.html), "(A) a value or selected attribute was kept");

      const section = await page.stopRegion!({ kind: "section", label: "Work Experience" });
      check(section.anchor === "role=group" && section.html.startsWith('<div role="group" aria-label="Work Experience">'), `(A) section ${section.anchor} ${section.html.slice(0, 80)}`);

      const capture = await captureStopEvidence(page, { kind: "field", fieldId: "city", label: "City" });
      check(capture.url === `${origin}/stop`, `(A) capture url ${capture.url}`);
      check(capture.region?.anchor === "id", "(A) capture has no region");

      const state = await tab.evaluate(() => {
        const window_ = window as unknown as { counts: Record<string, number>; mutations: number; activeBefore: Element | null };
        return { counts: window_.counts, mutations: window_.mutations, same: document.activeElement === window_.activeBefore, city: (document.getElementById("city") as HTMLInputElement).value };
      });
      check(Object.values(state.counts).every((value) => value === 0), `(A) the reads fired events ${JSON.stringify(state.counts)}`);
      check(state.mutations === 0, `(A) the reads changed the DOM (${state.mutations} mutations)`);
      check(state.same, "(A) the reads moved the focus");
      check(state.city === "TYPED-CITY-7781", "(A) the typed value changed");

      await tab.goto(`${origin}/big`);
      const big = await page.stopRegion!({ kind: "page" });
      check(big.truncated && big.html.length <= 12_000, `(A) big page truncated ${big.truncated} at ${big.html.length}`);
      await context.close();
    }

    // ---- (B) the default options keep no network state and no per-action screenshot ----
    const tracedFlow = async (context: BrowserContext): Promise<Page> => {
      const tab = await context.newPage();
      await tab.goto(`${origin}/form`);
      await tab.locator("#status", { hasText: "pinged" }).waitFor();
      await tab.fill("#name", "Jordan Rivera");
      await tab.click("#go");
      return tab;
    };
    // Per-action screen snapshots add `screenshots/call@…` entries and `"type":"screenshot"` events; the film strip is `screencast-frame` events.
    const perActionScreenshots = (path: string) => {
      const entries = readZipEntries(readFileSync(path));
      const trace = entries.find((entry) => entry.name === "trace.trace")?.data.toString("utf8") ?? "";
      return {
        entries: entries.some((entry) => entry.name.startsWith("screenshots/")),
        events: /"type":"screenshot"/.test(trace),
        filmStrip: /"type":"screencast-frame"/.test(trace)
      };
    };
    check(RUN_TRACE_OPTIONS.snapshots.screen === false, "(B) the default options take per-action screen snapshots");
    check(RUN_TRACE_SNAPSHOT_OPTIONS.snapshots.screen === true, "(B2) the snapshot options take no per-action screen snapshots");
    for (const [label, options] of [["B", RUN_TRACE_OPTIONS], ["B2", RUN_TRACE_SNAPSHOT_OPTIONS]] as const) {
      check(options.snapshots.dom === false && options.snapshots.aria === false && options.screenshots && !options.sources, `(${label}) options ${JSON.stringify(options)}`);
    }
    for (const [label, snapshots] of [["B", false], ["B2", true]] as const) {
      const context = await browser.newContext();
      const dir = traceDir(label.toLowerCase());
      const trace = (await startRunTrace(context, snapshots ? { dir, runId: null, snapshots } : { dir, runId: null }))!;
      check(trace !== null, `(${label}) tracing did not start`);
      await tracedFlow(context);
      const result = await trace.finish([]);
      check(result.dropped === null && result.saved.length === 1, `(${label}) result ${JSON.stringify(result)}`);
      const [saved] = result.saved;
      if (saved) {
        check(/^trace-job-[0-9TZ-]+\.zip$/.test(basename(saved)), `(${label}) file name ${basename(saved)}`);
        check(checkRunTraceZip(saved, []) === "ok", `(${label}) the check did not pass`);
        const entries = readZipEntries(readFileSync(saved));
        const network = entries.find((entry) => entry.name === "trace.network");
        check(!network || network.data.toString("utf8").trim() === "", `(${label}) trace.network is not empty`);
        const text = zipText([saved]);
        check(!/"type":"(?:resource|frame)-snapshot"/.test(text), `(${label}) a snapshot event was recorded`);
        for (const value of COOKIE_VALUES) check(!text.includes(value), `(${label}) the trace holds ${value}`);
        check(text.includes("Jordan Rivera"), `(${label}) the scan did not read the inflated trace (the typed name is missing)`);
        const shots = perActionScreenshots(saved);
        check(shots.filmStrip, `(${label}) the film strip (screencast frames) is missing`);
        if (snapshots) check(shots.entries && shots.events, `(${label}) snapshot mode recorded no per-action screenshot ${JSON.stringify(shots)}`);
        else check(!shots.entries && !shots.events, `(${label}) the default recorded per-action screenshots ${JSON.stringify(shots)}`);
        check(mode(saved) === 0o600, `(${label}) file mode ${mode(saved).toString(8)}`);
        check(mode(dir) === 0o700, `(${label}) folder mode ${mode(dir).toString(8)}`);
        check(!readdirSync(dir).some((name) => name.startsWith(".parts-")), `(${label}) a parts folder was left`);
      }
      await context.close();
    }

    // ---- (C) contrast: DOM snapshots record the network ----
    {
      const context = await browser.newContext();
      await context.tracing.start({ screenshots: true, snapshots: true });
      await tracedFlow(context);
      const path = join(temp, "contrast.zip");
      await context.tracing.stop({ path });
      const text = zipText([path]);
      check(["COOKIE-VALUE-7f3a", "AUTH-TOKEN-5c8d", "BODY-TOKEN-22e1"].some((value) => text.includes(value)), "(C) the contrast trace holds no cookie, header, or body value");
      check(checkRunTraceZip(path, []) === "network-found", `(C) the check returned ${checkRunTraceZip(path, [])}`);
      await context.close();
    }

    // ---- (D) a password typed inside a wrapped method is never recorded ----
    const signInSequence = async (context: BrowserContext, trace: RunTrace, wrap: boolean) => {
      const tab = await context.newPage();
      await tab.goto(`${origin}/form`);
      const adapter = {
        ...createPlaywrightPage(tab),
        signInToAccount: async () => {
          await tab.fill("#password", "PASSWORD-VALUE-4e9c");
          await tab.fill("#password", "");
          return "signed-in";
        }
      };
      if (wrap) wrapUntracedMethods(adapter, trace);
      await tab.fill("#name", "Jordan Rivera");
      await adapter.signInToAccount();
      await tab.click("#go");
    };
    {
      const context = await browser.newContext();
      const trace = (await startRunTrace(context, { dir: traceDir("d"), runId: "11111111-1111-4111-8111-111111111111" }))!;
      await signInSequence(context, trace, true);
      const result = await trace.finish(["PASSWORD-VALUE-4e9c"]);
      check(result.dropped === null && result.saved.length === 2, `(D) result ${JSON.stringify(result)}`);
      check(result.saved.map((path) => basename(path).replace(/^.*-(\d)\.zip$/, "$1")).join() === "1,2", `(D) part names ${result.saved.map((path) => basename(path)).join()}`);
      if (result.saved.length) check(!zipText(result.saved).includes("PASSWORD-VALUE-4e9c"), "(D) a saved part holds the password");
      await context.close();

      const unwrapped = await browser.newContext();
      const plain = (await startRunTrace(unwrapped, { dir: traceDir("d-contrast"), runId: null }))!;
      await signInSequence(unwrapped, plain, false);
      const kept = await plain.finish([]);
      check(kept.saved.length === 1 && zipText(kept.saved).includes("PASSWORD-VALUE-4e9c"), "(D) the unwrapped contrast did not record the password");
      await unwrapped.close();
    }

    // ---- (E) nothing is recorded after a security code ----
    {
      const context = await browser.newContext();
      const trace = (await startRunTrace(context, { dir: traceDir("e"), runId: null }))!;
      const tab = await context.newPage();
      await tab.goto(`${origin}/form`);
      const adapter = { ...createPlaywrightPage(tab), submitSecurityCode: async (code: string) => { await tab.fill("#code", code); } };
      wrapUntracedMethods(adapter, trace);
      await tab.fill("#name", "Jordan Rivera");
      await adapter.submitSecurityCode("CODE-883201");
      await tab.fill("#name", "AFTER-CODE-VALUE");
      const result = await trace.finish([]);
      check(result.saved.length === 1, `(E) result ${JSON.stringify(result)}`);
      if (result.saved.length) {
        const text = zipText(result.saved);
        check(!text.includes("CODE-883201") && !text.includes("AFTER-CODE-VALUE"), "(E) the trace holds the code or a value typed after it");
        check(text.includes("Jordan Rivera"), "(E) the part before the code was not kept");
      }
      await context.close();
    }

    // ---- (F) the secret scan, unknown secrets, and a clean end ----
    {
      const scanned = await browser.newContext();
      const dir = traceDir("f");
      const trace = (await startRunTrace(scanned, { dir, runId: null }))!;
      const tab = await scanned.newPage();
      await tab.goto(`${origin}/form`);
      await tab.fill("#name", "SCAN-SECRET-3a1f");
      const dropped = await trace.finish(["SCAN-SECRET-3a1f"]);
      check(dropped.saved.length === 0 && dropped.dropped === "secret-found", `(F) scan result ${JSON.stringify(dropped)}`);
      check(!existsSync(dir) || readdirSync(dir).length === 0, `(F) files left after a dropped trace: ${existsSync(dir) ? readdirSync(dir).join() : ""}`);
      check((await trace.finish([])).dropped === "secret-found", "(F) finish is not idempotent");
      await scanned.close();

      const unknown = await browser.newContext();
      const unknownTrace = (await startRunTrace(unknown, { dir: traceDir("f-unknown"), runId: null }))!;
      await (await unknown.newPage()).goto(`${origin}/form`);
      check((await unknownTrace.finish(null)).dropped === "secrets-unknown", "(F) unknown secrets did not drop the trace");
      await unknown.close();

      const clean = await browser.newContext();
      const cleanDir = traceDir("f-clean");
      const cleanTrace = (await startRunTrace(clean, { dir: cleanDir, runId: null }))!;
      const cleanTab = await clean.newPage();
      await cleanTab.goto(`${origin}/form`);
      await cleanTab.fill("#name", "Jordan Rivera");
      cleanTrace.endedCleanly();
      const discarded = await cleanTrace.finish([]);
      check(discarded.saved.length === 0 && discarded.dropped === null, `(F) clean result ${JSON.stringify(discarded)}`);
      check(!existsSync(cleanDir) || readdirSync(cleanDir).length === 0, "(F) a clean end left files");
      await clean.close();
    }

    // ---- (G) pruning and the zip reader ----
    {
      const dataDir = join(temp, "prune");
      const hours = (count: number) => new Date(Date.now() - count * 60 * 60 * 1000);
      const at = (path: string, when: Date) => utimesSync(path, when, when);
      const old = join(dataDir, "applications", "j1", "run-traces");
      mkdirSync(old, { recursive: true });
      const stale = join(old, "trace-job-2026-11-01T00-00-00-000Z.zip");
      writeFileSync(stale, "x");
      at(stale, hours(15 * 24));
      const parts = join(old, ".parts-x");
      mkdirSync(parts);
      writeFileSync(join(parts, "part-1.zip"), "x");
      at(parts, hours(48));
      const capped = join(dataDir, "applications", "j2", "run-traces");
      mkdirSync(capped, { recursive: true });
      const sized = [3, 2, 1].map((age, index) => {
        const path = join(capped, `trace-job-2026-11-2${index}T00-00-00-000Z.zip`);
        writeFileSync(path, Buffer.alloc(1_024));
        at(path, hours(age));
        return path;
      });
      const resources = join(dataDir, "trace-artifacts", "resources");
      mkdirSync(resources, { recursive: true });
      const oldResource = join(resources, "old-frame.jpeg");
      const freshResource = join(resources, "fresh-frame.jpeg");
      const oldTrace = join(dataDir, "trace-artifacts", "old.trace");
      writeFileSync(oldResource, "x");
      writeFileSync(freshResource, "x");
      writeFileSync(oldTrace, "x");
      at(oldResource, hours(48));
      at(oldTrace, hours(48));
      at(resources, new Date());
      pruneRunTraces(dataDir, { maxTotalBytes: 2_048 });
      check(!existsSync(stale), "(G) a 15-day-old trace was kept");
      check(!existsSync(parts), "(G) a 2-day-old parts folder was kept");
      check(!existsSync(sized[0]!) && existsSync(sized[1]!) && existsSync(sized[2]!), "(G) the size cap did not delete only the oldest");
      check(!existsSync(oldResource) && !existsSync(oldTrace), "(G) an old intermediate file was kept");
      check(existsSync(freshResource), "(G) a fresh intermediate file was deleted");
      check(existsSync(join(dataDir, "trace-artifacts")), "(G) the artifacts folder itself was removed");

      const files = [{ name: "trace.trace", text: '{"type":"context-options"}\n', deflate: false }, { name: "resources/a.txt", text: "deflated entry ".repeat(20), deflate: true }];
      const zipped = buildZip(files);
      const read = readZipEntries(zipped);
      check(read.length === 2 && read[0]!.data.toString() === files[0]!.text && read[1]!.data.toString() === files[1]!.text, "(G) the zip reader did not read stored and deflated entries");
      let refused = false;
      try {
        readZipEntries(zipped.subarray(0, zipped.length - 30));
      } catch {
        refused = true;
      }
      check(refused, "(G) the zip reader read a truncated file");
      const zipAt = (name: string, entries: typeof files) => {
        const path = join(temp, name);
        writeFileSync(path, buildZip(entries));
        return path;
      };
      check(checkRunTraceZip(zipAt("ok.zip", files), []) === "ok", "(G) a clean zip did not pass");
      check(checkRunTraceZip(zipAt("snap.zip", [{ name: "trace.trace", text: '{"type":"frame-snapshot"}\n', deflate: true }]), []) === "network-found", "(G) a frame snapshot passed");
      check(checkRunTraceZip(zipAt("bad.zip", [{ name: "trace.trace", text: "not json\n", deflate: false }]), []) === "unreadable", "(G) an unparsable trace passed");
      check(checkRunTraceZip(zipAt("none.zip", [{ name: "other.txt", text: "x", deflate: false }]), []) === "unreadable", "(G) a zip without trace.trace passed");
      check(checkRunTraceZip(zipAt("escaped.zip", [{ name: "trace.trace", text: `${JSON.stringify({ type: "before", params: { value: 'pa"ss\\word' } })}\n`, deflate: true }]), ['pa"ss\\word']) === "secret-found", "(G) a JSON-escaped secret passed");
    }

    // ---- (H) overhead on the fixture suites (informational) ----
    {
      const pdf = join(temp, "resume.pdf");
      writeFileSync(pdf, "%PDF-1.4\n% fixture\n%%EOF\n");
      const handshakeUrl = pathToFileURL(join(process.cwd(), "testing-harness/browser/fixtures/handshake-application.html")).href;
      const workdayUrl = pathToFileURL(join(process.cwd(), "testing-harness/browser/fixtures/workday-application.html")).href;
      const handshake = async (tab: Page) => {
        await tab.goto(handshakeUrl);
        const adapted = createPlaywrightPage(tab);
        const form = await recognizeCurrentForm(adapted);
        const plan = planAutofill(form, {
          profile: { email: "jordan@example.com" },
          resolutions: new Map([["auth", { status: "RESOLVED", key: "authorized_to_work", scope: "country:US", display: "Yes", value: true }]]),
          packageAnswers: [{ prompt: "Why are you interested in this role?", text: "I am excited about this internship." }],
          variantId: "11111111-1111-4111-8111-111111111111",
          transcriptDocumentId: "33333333-3333-4333-8333-333333333333"
        });
        await applyDecisions(adapted, form, plan.decisions, (decision) => (decision.action === "upload" ? pdf : null));
      };
      const workday = async (tab: Page) => {
        await tab.goto(workdayUrl);
        const page = createWorkdayPage(tab);
        await page.enterApplication();
        const contact = { legalFirstName: "Jordan", legalLastName: "Rivera", addressCity: "Seattle", addressRegion: "Washington", addressCountry: "United States of America", phoneType: "Mobile" };
        const walk = await walkWorkdayApplication(page, async (_step, form) => {
          const planned = planAutofill(form, { profile: contact, resolutions: new Map(), packageAnswers: [], variantId: "11111111-1111-4111-8111-111111111111", transcriptDocumentId: null });
          return { ...planned, uploadPathFor: (decision: { action: string }) => (decision.action === "upload" ? pdf : null) };
        }, { mode: "fill" });
        if (walk.outcome !== "paused") failures.push(`(H) the Workday fixture walk ended ${walk.outcome}`);
      };
      const measure = async (name: string, work: (tab: Page) => Promise<void>) => {
        const untraced: number[] = [];
        const traced = { default: [] as number[], snapshot: [] as number[] };
        const bytes = { default: [] as number[], snapshot: [] as number[] };
        for (let round = 0; round < 3; round += 1) {
          let begin = Date.now();
          const plain = await browser.newContext();
          await work(await plain.newPage());
          await plain.close();
          untraced.push(Date.now() - begin);
          for (const kind of ["default", "snapshot"] as const) {
            begin = Date.now();
            const context = await browser.newContext();
            const dir = traceDir(`h-${name}-${kind}-${round}`);
            const trace = (await startRunTrace(context, kind === "snapshot" ? { dir, runId: null, snapshots: true } : { dir, runId: null }))!;
            await work(await context.newPage());
            const result = await trace.finish([]);
            await context.close();
            traced[kind].push(Date.now() - begin);
            bytes[kind].push(result.saved.reduce((sum, path) => sum + statSync(path).size, 0));
            if (result.saved.length !== 1) failures.push(`(H) ${name} ${kind} trace ${JSON.stringify(result)}`);
          }
        }
        const base = median(untraced);
        const pct = (ms: number) => Math.round(((ms - base) / base) * 1000) / 10;
        const defaultMs = median(traced.default);
        const snapshotMs = median(traced.snapshot);
        return {
          untracedMs: base,
          defaultMs,
          defaultOverheadPct: pct(defaultMs),
          defaultBytes: median(bytes.default),
          snapshotMs,
          snapshotOverheadPct: pct(snapshotMs),
          snapshotBytes: median(bytes.snapshot),
          runs: { untraced, traced, bytes }
        };
      };
      overhead = { handshake: await measure("handshake", handshake), workday: await measure("workday", workday) };
    }

    // ---- (J) the snapshot setting (pure) ----
    {
      const wanted = (env: Record<string, string | undefined>, url: string, expected: boolean) =>
        check(traceSnapshotsWanted(url, env) === expected, `(J) ${JSON.stringify(env)} at ${url} is not ${expected}`);
      const hosts = "careers.fixtureaero.example, Fixturelabs.wd5.example";
      wanted({}, "https://fixturelabs.wd5.example/x", false);
      wanted({ INTERNSHIP_AGENT_TRACE_SNAPSHOTS: "1" }, "https://any.example/path", true);
      wanted({ INTERNSHIP_AGENT_TRACE_SNAPSHOTS: "1" }, "not a url", true);
      wanted({ INTERNSHIP_AGENT_TRACE_SNAPSHOTS: "true" }, "https://any.example/", false);
      wanted({ INTERNSHIP_AGENT_TRACE_SNAPSHOTS: "0" }, "https://any.example/", false);
      const listed = { INTERNSHIP_AGENT_TRACE_SNAPSHOTS: "1", INTERNSHIP_AGENT_TRACE_SNAPSHOT_HOSTS: hosts };
      wanted(listed, "https://fixturelabs.wd5.example/x", true);
      wanted(listed, "https://careers.fixtureaero.example/careers", true);
      wanted(listed, "https://other.example/", false);
      wanted(listed, "https://a.fixturelabs.wd5.example/", false);
      wanted(listed, "not a url", false);
      wanted({ INTERNSHIP_AGENT_TRACE_SNAPSHOT_HOSTS: hosts }, "https://fixturelabs.wd5.example/x", false);
      wanted({ INTERNSHIP_AGENT_TRACE_SNAPSHOTS: "1", INTERNSHIP_AGENT_TRACE_SNAPSHOT_HOSTS: "  , " }, "https://other.example/", true);
    }

    // ---- (I) git ignores what stays local ----
    for (const path of ["data/profiles/real/applications/x/run-traces/trace-job-1.zip", "data/profiles/real/applications/x/stop-evidence/a/evidence.json"]) {
      try {
        execFileSync("git", ["check-ignore", "-q", path], { cwd: process.cwd(), stdio: "ignore" });
      } catch {
        failures.push(`(I) git does not ignore ${path}`);
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    if (basename(temp).startsWith(PREFIX)) rmSync(temp, { recursive: true, force: true });
  }
  console.log(`RUN_TRACE_REPORT ${JSON.stringify({ status: failures.length ? "failed" : "passed", overhead })}`);
  if (failures.length) {
    console.error(`STOP_EVIDENCE_REPORT ${JSON.stringify({ status: "failed", failures })}`);
    process.exit(1);
  }
  console.log(`STOP_EVIDENCE_REPORT ${JSON.stringify({ status: "passed", scenarios: 11 })}`);
}

main().catch((error) => {
  console.error(`STOP_EVIDENCE_REPORT ${JSON.stringify({ status: "failed", failures: [error instanceof Error ? error.message : String(error)] })}`);
  process.exit(1);
});
