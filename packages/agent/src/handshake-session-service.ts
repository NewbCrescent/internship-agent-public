import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { chromium } from "playwright-core";

import { getBrowserSession, getDatabase, saveBrowserSession } from "@internship-agent/db";
import { classifyHandshakeUrl, HANDSHAKE_LOGIN_URL, resolveDataDir } from "@internship-agent/browser";
import type { BrowserSession, BrowserSessionStatus } from "@internship-agent/domain";

/** The minimal surface of a visible sign-in window; tests pass a stub. */
export type SessionWindow = {
  urls(): string[];
  isClosed(): boolean;
  close(): Promise<void>;
};

export type SessionWindowFactory = (url: string) => Promise<SessionWindow>;

const pendingConnections = new Map<string, Promise<BrowserSession>>();

export function getHandshakeSession(database: DatabaseSync = getDatabase()): BrowserSession | null {
  return getBrowserSession(database, "handshake");
}

/**
 * Opens a visible window on Handshake's login page in the candidate's own
 * persistent browser profile and waits for the candidate to sign in by hand
 * and close the window. The agent never reads, types, or stores credentials;
 * it watches only page URLs to learn which Handshake page the window ended on.
 */
export function connectHandshake(options: {
  database?: DatabaseSync;
  dataDir?: string;
  openWindow?: SessionWindowFactory;
  pollMs?: number;
  timeoutMs?: number;
} = {}): Promise<BrowserSession> {
  const dataDir = resolveDataDir(options.dataDir);
  const pending = pendingConnections.get(dataDir);
  if (pending) return pending;
  const connection = runConnection(dataDir, options).finally(() => pendingConnections.delete(dataDir));
  pendingConnections.set(dataDir, connection);
  return connection;
}

export function isHandshakeConnectionPending(dataDir?: string): boolean {
  return pendingConnections.has(resolveDataDir(dataDir));
}

async function runConnection(
  dataDir: string,
  options: { database?: DatabaseSync; openWindow?: SessionWindowFactory; pollMs?: number; timeoutMs?: number }
): Promise<BrowserSession> {
  const database = options.database ?? getDatabase();
  const openWindow = options.openWindow ?? ((url: string) => openVisibleProfileWindow(url, dataDir));
  const pollMs = options.pollMs ?? 1_000;
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);

  recordSession(database, "unknown", "A sign-in window is open. Sign in to Handshake, then close the window.");
  let window: SessionWindow;
  try {
    window = await openWindow(HANDSHAKE_LOGIN_URL);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0]!.slice(0, 300) : "unknown error";
    recordSession(database, "unknown", `The sign-in window could not open: ${reason}`);
    throw error;
  }
  // The window stays open until the candidate closes it: a URL guess must
  // never cut a sign-in short. The last Handshake page seen decides the status.
  let last: "connected" | "signed_out" | null = null;
  let timedOut = true;
  try {
    while (Date.now() < deadline) {
      if (window.isClosed()) {
        timedOut = false;
        break;
      }
      const states = window.urls().map(classifyHandshakeUrl);
      if (states.includes("connected")) last = "connected";
      else if (states.includes("signed_out")) last = "signed_out";
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    if (!window.isClosed()) await window.close();
  }

  const ending = timedOut ? "The sign-in window timed out" : "The sign-in window was closed";
  if (last === "connected") {
    return recordSession(database, "connected", `${ending} on a signed-in Handshake page. The session is saved in this profile's browser data.`);
  }
  if (last === "signed_out") {
    return recordSession(database, "signed_out", `${ending} on a Handshake sign-in page. Connect again and finish signing in.`);
  }
  return recordSession(database, "unknown", `${ending} before any Handshake page loaded.`);
}

/**
 * Checks the page a run landed on. A Handshake sign-in page stops the run
 * before anything is filled; a signed-in Handshake page refreshes the
 * recorded status. Non-Handshake pages are left alone.
 */
export function assertHandshakeSignedIn(database: DatabaseSync, pageUrl: string): void {
  const state = classifyHandshakeUrl(pageUrl);
  if (state === "signed_out") {
    recordSession(database, "signed_out", "A browser run landed on a Handshake sign-in page.");
    throw new Error("Handshake is signed out. Use Connect Handshake on the profile page, then start the run again.");
  }
  if (state === "connected") {
    recordSession(database, "connected", "A browser run reached a signed-in Handshake page.");
  }
}

function recordSession(database: DatabaseSync, status: BrowserSessionStatus, detail: string): BrowserSession {
  return saveBrowserSession(database, { site: "handshake", status, detail, checkedAt: new Date().toISOString() });
}

async function openVisibleProfileWindow(url: string, dataDir: string): Promise<SessionWindow> {
  mkdirSync(join(dataDir, "browser-profile"), { recursive: true });
  // Sign-in is always visible: the candidate types their own credentials.
  const context = await chromium.launchPersistentContext(join(dataDir, "browser-profile"), {
    headless: false,
    args: ["--disable-dev-shm-usage"]
  });
  let closed = false;
  context.on("close", () => {
    closed = true;
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(url);
  // On macOS, closing the last window leaves Chromium running, so "no tabs
  // left" also counts as the candidate closing the window.
  return {
    urls: () => (closed ? [] : context.pages().map((entry) => entry.url())),
    isClosed: () => closed || context.pages().length === 0,
    close: async () => {
      if (!closed) await context.close();
    }
  };
}
