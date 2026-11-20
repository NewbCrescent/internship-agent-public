import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { chromium } from "playwright-core";

import { getBrowserSession, getDatabase, listJobSummaries, saveBrowserSession } from "@internship-agent/db";
import { resolveDataDir } from "@internship-agent/browser";
import { parseWorkdayUrl, workdaySiteKey, type BrowserSession, type BrowserSessionStatus } from "@internship-agent/domain";

import { isHandshakeConnectionPending, type SessionWindow } from "./handshake-session-service";
import { readPipelineLock } from "./pipeline-lock";

/** A visible sign-in window that can also ask Workday whether it is signed in. */
export type WorkdaySessionWindow = SessionWindow & {
  /** Workday's own answer for this site (`userAuthenticated`), or null when it cannot be read. */
  signedIn(): Promise<boolean | null>;
};
export type WorkdayWindowFactory = (jobUrl: string) => Promise<WorkdaySessionWindow>;

export type WorkdaySite = {
  siteKey: string;
  host: string;
  site: string;
  companies: string[];
  /** Applications on this site that are prepared or in progress. */
  applications: number;
  /** A posting page on the site, where the candidate signs in or creates the account. */
  jobUrl: string;
  session: BrowserSession | null;
};

const ACTIVE_STATUSES = new Set(["QUALIFIED", "READY_FOR_REVIEW", "NEEDS_INPUT", "APPLYING"]);
const pendingConnections = new Map<string, Promise<BrowserSession>>();

/** Workday sites with applications waiting, most applications first. */
export function listWorkdaySites(database: DatabaseSync = getDatabase()): WorkdaySite[] {
  const sites = new Map<string, WorkdaySite>();
  for (const job of listJobSummaries(database)) {
    if (!ACTIVE_STATUSES.has(job.status) || !job.sourceUrl) continue;
    const location = parseWorkdayUrl(job.sourceUrl);
    if (!location?.jobPath) continue;
    const siteKey = workdaySiteKey(location);
    const entry = sites.get(siteKey) ?? {
      siteKey, host: location.host, site: location.site, companies: [], applications: 0, jobUrl: job.sourceUrl,
      session: getBrowserSession(database, siteKey)
    };
    entry.applications += 1;
    if (!entry.companies.includes(job.companyName)) entry.companies.push(job.companyName);
    sites.set(siteKey, entry);
  }
  return [...sites.values()].sort((a, b) => b.applications - a.applications || a.siteKey.localeCompare(b.siteKey));
}

export function getWorkdaySession(siteKey: string, database: DatabaseSync = getDatabase()): BrowserSession | null {
  return getBrowserSession(database, siteKey);
}

/** Why the candidate's browser profile cannot open a sign-in window right now, or null. */
export function browserProfileBusy(dataDir?: string): string | null {
  const resolved = resolveDataDir(dataDir);
  if (readPipelineLock(resolved)) return "A pipeline run is using the agent's browser. Try again when it finishes.";
  if (isHandshakeConnectionPending(resolved)) return "The Handshake sign-in window is still open. Close it first.";
  if (pendingConnections.has(resolved)) return "A Workday sign-in window is already open. Close it first.";
  return null;
}

/**
 * Opens a visible window on a posting of this Workday site in the
 * candidate's persistent browser profile. The candidate signs in or creates
 * the account themselves (password manager, email verification, any
 * challenge); the agent never reads, types, or stores credentials. It asks
 * Workday's own job endpoint whether the session is authenticated, and the
 * last answer before the window closes decides the recorded status.
 */
export function connectWorkdaySite(siteKey: string, options: {
  database?: DatabaseSync;
  dataDir?: string;
  openWindow?: WorkdayWindowFactory;
  pollMs?: number;
  timeoutMs?: number;
} = {}): Promise<BrowserSession> {
  const database = options.database ?? getDatabase();
  const dataDir = resolveDataDir(options.dataDir);
  const busy = browserProfileBusy(dataDir);
  if (busy) return Promise.reject(new Error(busy));
  const site = listWorkdaySites(database).find((entry) => entry.siteKey === siteKey);
  if (!site) return Promise.reject(new Error("No waiting application uses this Workday site."));
  const connection = runConnection(database, site, dataDir, options).finally(() => pendingConnections.delete(dataDir));
  pendingConnections.set(dataDir, connection);
  return connection;
}

async function runConnection(
  database: DatabaseSync,
  site: WorkdaySite,
  dataDir: string,
  options: { openWindow?: WorkdayWindowFactory; pollMs?: number; timeoutMs?: number }
): Promise<BrowserSession> {
  const openWindow = options.openWindow ?? ((url: string) => openWorkdayWindow(url, dataDir));
  const pollMs = options.pollMs ?? 3_000;
  const deadline = Date.now() + (options.timeoutMs ?? 20 * 60_000);
  const company = site.companies[0] ?? site.host;
  record(database, site.siteKey, "unknown", `A sign-in window is open for ${company}'s Workday. Sign in or create the account there, then close the window.`);
  let window: WorkdaySessionWindow;
  try {
    window = await openWindow(site.jobUrl);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0]!.slice(0, 300) : "unknown error";
    record(database, site.siteKey, "unknown", `The sign-in window could not open: ${reason}`);
    throw error;
  }
  let last: boolean | null = null;
  let timedOut = true;
  try {
    while (Date.now() < deadline) {
      if (window.isClosed()) { timedOut = false; break; }
      const answer = await window.signedIn().catch(() => null);
      if (answer !== null) last = answer;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    if (!window.isClosed()) await window.close();
  }
  const ending = timedOut ? "The sign-in window timed out" : "The sign-in window was closed";
  if (last === true) return record(database, site.siteKey, "connected", `${ending} while signed in to ${company}'s Workday. The session is saved in this profile's browser data.`);
  if (last === false) return record(database, site.siteKey, "signed_out", `${ending} before signing in to ${company}'s Workday. Open sign-in again to finish.`);
  return record(database, site.siteKey, "unknown", `${ending} before Workday reported a sign-in state.`);
}

function record(database: DatabaseSync, siteKey: string, status: BrowserSessionStatus, detail: string): BrowserSession {
  return saveBrowserSession(database, { site: siteKey, status, detail: detail.slice(0, 500), checkedAt: new Date().toISOString() });
}

async function openWorkdayWindow(jobUrl: string, dataDir: string): Promise<WorkdaySessionWindow> {
  const location = parseWorkdayUrl(jobUrl);
  if (!location?.jobPath) throw new Error("The Workday posting address is not a job page.");
  mkdirSync(join(dataDir, "browser-profile"), { recursive: true });
  const context = await chromium.launchPersistentContext(join(dataDir, "browser-profile"), {
    headless: false,
    args: ["--disable-dev-shm-usage"]
  });
  let closed = false;
  context.on("close", () => { closed = true; });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(jobUrl);
  // The same public job endpoint discovery reads, sent with this profile's
  // cookies: Workday answers whether the visitor is authenticated.
  const endpoint = `https://${location.host}/wday/cxs/${location.tenant}/${location.site}/job/${location.jobPath}`;
  return {
    urls: () => (closed ? [] : context.pages().map((entry) => entry.url())),
    isClosed: () => closed || context.pages().length === 0,
    close: async () => { if (!closed) await context.close(); },
    signedIn: async () => {
      if (closed) return null;
      const response = await context.request.get(endpoint, { headers: { accept: "application/json" }, timeout: 15_000 });
      if (!response.ok()) return null;
      const body = await response.json() as { userAuthenticated?: unknown };
      return typeof body.userAuthenticated === "boolean" ? body.userAuthenticated : null;
    }
  };
}
