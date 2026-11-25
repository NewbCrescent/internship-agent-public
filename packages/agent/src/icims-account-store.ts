import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import type { WorkspaceProfile } from "@internship-agent/domain";

/**
 * iCIMS candidate accounts the agent created or signed in to, one per iCIMS
 * tenant host, at the candidate's request (INTERNSHIP_AGENT_ICIMS_ACCOUNTS).
 * The same design as the Workday accounts file: outside the repository and
 * the data directory, owner-only, never copied into SQLite, logs, reports,
 * timelines, or model prompts. Passwords come from generateWorkdayPassword.
 */
const holdSchema = z.object({
  kind: z.enum([
    "captcha", "verify-email", "exists-no-password", "exists", "password-refused", "wrong-password", "interrupted", "locked",
    "consent-setting", "attestation-setting", "consent-unknown", "profile", "unexpected"
  ]),
  reason: z.string().max(500),
  at: z.string(),
  attempts: z.number().int().min(1)
}).strict();

const entrySchema = z.object({
  host: z.string(),
  email: z.email(),
  password: z.string().min(8).nullable(),
  account: z.enum(["pending", "created", "refused"]).nullable(),
  hold: holdSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
}).strict();

const fileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string(), entrySchema)
}).strict();

export type IcimsAccountHold = z.infer<typeof holdSchema>;
export type IcimsAccountHoldKind = IcimsAccountHold["kind"];
export type IcimsAccountEntry = z.infer<typeof entrySchema>;

/** The iCIMS accounts file is damaged or unreadable; it is never overwritten. The message names the path only. */
export class IcimsAccountsFileError extends Error {}

export function readIcimsAccounts(file: string): Record<string, IcimsAccountEntry> {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new IcimsAccountsFileError(`The iCIMS accounts file ${file} cannot be read.`);
  }
  const result = fileSchema.safeParse(parsed);
  if (!result.success) throw new IcimsAccountsFileError(`The iCIMS accounts file ${file} is not in the expected format.`);
  return result.data.accounts;
}

export function getIcimsAccount(file: string, host: string): IcimsAccountEntry | null {
  return readIcimsAccounts(file)[host] ?? null;
}

/** Replaces one host's entry with an atomic, owner-only write. */
export function putIcimsAccount(file: string, entry: IcimsAccountEntry): void {
  const accounts = readIcimsAccounts(file);
  accounts[entry.host] = entrySchema.parse(entry);
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let renamed = false;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
    renamed = true;
    chmodSync(file, 0o600);
  } finally {
    if (!renamed) rmSync(temporary, { force: true });
  }
}

/** A summary without emails or passwords. */
export function listIcimsAccounts(file: string): Array<{ host: string; account: IcimsAccountEntry["account"]; hold: IcimsAccountHoldKind | null; updatedAt: string }> {
  return Object.values(readIcimsAccounts(file))
    .map((entry) => ({ host: entry.host, account: entry.account, hold: entry.hold?.kind ?? null, updatedAt: entry.updatedAt }))
    .sort((left, right) => left.host.localeCompare(right.host));
}

/** Clears a host's hold so the next pass retries it; the password and account state stay. False when the host has no entry. */
export function clearIcimsAccountHold(file: string, host: string, now: Date = new Date()): boolean {
  const entry = getIcimsAccount(file, host);
  if (!entry) return false;
  putIcimsAccount(file, { ...entry, hold: null, updatedAt: now.toISOString() });
  return true;
}

/**
 * The iCIMS accounts file: INTERNSHIP_AGENT_ICIMS_ACCOUNTS_FILE when set,
 * otherwise (only when INTERNSHIP_AGENT_DATA_DIR is unset) one per profile
 * under ~/.config/internship-agent. Null means iCIMS accounts are off.
 */
export function icimsAccountsFile(profile: WorkspaceProfile, env: Record<string, string | undefined> = process.env): string | null {
  const override = env.INTERNSHIP_AGENT_ICIMS_ACCOUNTS_FILE?.trim();
  if (override) return resolve(override);
  if (env.INTERNSHIP_AGENT_DATA_DIR?.trim()) return null;
  const config = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(config, "internship-agent", profile, "icims-accounts.json");
}
