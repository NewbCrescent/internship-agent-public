import { randomBytes, randomInt } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import type { WorkspaceProfile } from "@internship-agent/domain";

/**
 * Workday candidate accounts the agent created, one per Workday host
 * (tenant). The file lives outside the repository and the data directory,
 * with owner-only permissions; it is never copied into SQLite, logs,
 * reports, timelines, or model prompts.
 */
const holdSchema = z.object({
  kind: z.enum(["captcha", "verify-email", "exists", "password-refused", "wrong-password", "interrupted", "locked", "unexpected"]),
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

export type WorkdayAccountHold = z.infer<typeof holdSchema>;
export type WorkdayAccountHoldKind = WorkdayAccountHold["kind"];
export type WorkdayAccountEntry = z.infer<typeof entrySchema>;

/** The accounts file is damaged or unreadable; it is never overwritten. The message names the path only. */
export class WorkdayAccountsFileError extends Error {}

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*";

/** A random 16-character password with an upper, a lower, a digit, and a symbol. */
export function generateWorkdayPassword(): string {
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const pick = (alphabet: string) => alphabet[randomInt(alphabet.length)]!;
  const characters = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (characters.length < 16) characters.push(pick(all));
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [characters[index], characters[other]] = [characters[other]!, characters[index]!];
  }
  return characters.join("");
}

export function readWorkdayAccounts(file: string): Record<string, WorkdayAccountEntry> {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new WorkdayAccountsFileError(`The Workday accounts file ${file} cannot be read.`);
  }
  const result = fileSchema.safeParse(parsed);
  if (!result.success) throw new WorkdayAccountsFileError(`The Workday accounts file ${file} is not in the expected format.`);
  return result.data.accounts;
}

export function getWorkdayAccount(file: string, host: string): WorkdayAccountEntry | null {
  return readWorkdayAccounts(file)[host] ?? null;
}

/** Replaces one host's entry with an atomic, owner-only write. */
export function putWorkdayAccount(file: string, entry: WorkdayAccountEntry): void {
  const accounts = readWorkdayAccounts(file);
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
export function listWorkdayAccounts(file: string): Array<{ host: string; account: WorkdayAccountEntry["account"]; hold: WorkdayAccountHoldKind | null; updatedAt: string }> {
  return Object.values(readWorkdayAccounts(file))
    .map((entry) => ({ host: entry.host, account: entry.account, hold: entry.hold?.kind ?? null, updatedAt: entry.updatedAt }))
    .sort((left, right) => left.host.localeCompare(right.host));
}

/**
 * The accounts file: INTERNSHIP_AGENT_WORKDAY_ACCOUNTS_FILE when set,
 * otherwise (only when INTERNSHIP_AGENT_DATA_DIR is unset) one per profile
 * under ~/.config/internship-agent. Null means account automation is off.
 */
export function workdayAccountsFile(profile: WorkspaceProfile, env: Record<string, string | undefined> = process.env): string | null {
  const override = env.INTERNSHIP_AGENT_WORKDAY_ACCOUNTS_FILE?.trim();
  if (override) return resolve(override);
  if (env.INTERNSHIP_AGENT_DATA_DIR?.trim()) return null;
  const config = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(config, "internship-agent", profile, "workday-accounts.json");
}
