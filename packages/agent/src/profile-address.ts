import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import {
  closeProfileDatabase,
  getCandidate,
  getProfileDatabase,
  LOCAL_CANDIDATE_ID,
  resolveProfileDataDirectory
} from "@internship-agent/db";
import {
  candidateProfileInputSchema,
  workspaceProfileSchema,
  type Candidate,
  type WorkspaceProfile
} from "@internship-agent/domain";
import { z } from "zod";

import { updateCandidateProfile } from "./candidate-service";
import { acquirePipelineLock } from "./pipeline-lock";

/**
 * `pnpm profile:address`: sets the candidate profile's mailing address (the
 * dashboard profile page's address fields) without the dashboard. The file
 * names only the address fields it changes, validated by the profile
 * schema's own rules with unknown keys refused; an empty string clears a
 * field. The save goes through updateCandidateProfile, the dashboard
 * action's service, under the workspace's pipeline lock (a profile save
 * bumps the AI-fit context version, which would make in-flight fit saves
 * fail). Only field names are printed, never values, not even in errors.
 */

export const ADDRESS_FIELDS = [
  "addressLine1",
  "addressLine2",
  "addressCity",
  "addressRegion",
  "addressPostalCode",
  "addressCountry"
] as const;

export type AddressField = (typeof ADDRESS_FIELDS)[number];

export const addressFileSchema = candidateProfileInputSchema.pick({
  addressLine1: true,
  addressLine2: true,
  addressCity: true,
  addressRegion: true,
  addressPostalCode: true,
  addressCountry: true
}).strict();

export type AddressFile = z.infer<typeof addressFileSchema>;

export type ProfileAddressDeps = {
  open(profile: WorkspaceProfile): DatabaseSync;
  close(profile: WorkspaceProfile): void;
  readFile(path: string): string;
  log(line: string): void;
  /** Takes the workspace's pipeline lock; returns its release function. */
  lock(profile: WorkspaceProfile): () => void;
};

const USAGE = "Usage: pnpm profile:address --profile real|demo [--list | --set-file <address.json> [--dry-run]]";

type Change = { field: AddressField; kind: "set" | "cleared" | "unchanged"; value: string | undefined };

/** What the file changes against the saved profile; an empty string clears a field. */
export function addressChanges(candidate: Candidate, file: AddressFile): Change[] {
  const changes: Change[] = [];
  for (const field of ADDRESS_FIELDS) {
    if (!(field in file)) continue;
    const given = file[field]?.trim() || undefined;
    const saved = candidate[field]?.trim() || undefined;
    if (given === saved) changes.push({ field, kind: "unchanged", value: given });
    else changes.push({ field, kind: given === undefined ? "cleared" : "set", value: given });
  }
  return changes;
}

/** The saved address fields by name, as "set" or "not set", never their values. */
export function listAddressLines(database: DatabaseSync, candidateId: string = LOCAL_CANDIDATE_ID): string[] {
  const candidate = getCandidate(database, candidateId);
  if (!candidate) return ["The workspace has no candidate profile."];
  return ADDRESS_FIELDS.map((field) => `${field} [profile]: ${candidate[field]?.trim() ? "set" : "not set"}`);
}

type ParsedArgs = { profile: WorkspaceProfile; setFile: string | null; dryRun: boolean };

function parseArgs(argv: string[]): ParsedArgs | null {
  let profile: string | null = null;
  let setFile: string | null = null;
  let list = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      profile = argv[++index] ?? null;
      if (!profile) return null;
    } else if (arg === "--set-file") {
      setFile = argv[++index] ?? null;
      if (!setFile) return null;
    } else if (arg === "--list") list = true;
    else if (arg === "--dry-run") dryRun = true;
    else return null;
  }
  if (list && setFile) return null;
  if (dryRun && !setFile) return null;
  const parsed = workspaceProfileSchema.safeParse(profile);
  return parsed.success ? { profile: parsed.data, setFile, dryRun } : null;
}

function readAddressFile(path: string, io: ProfileAddressDeps): AddressFile | null {
  let text: string;
  try {
    text = io.readFile(path);
  } catch {
    io.log("The address file could not be read.");
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    io.log("The address file is not valid JSON.");
    return null;
  }
  // Only key names and paths are printed, never values.
  const parsed = addressFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issue.path.join(".") || "(root)";
      io.log(issue.code === "unrecognized_keys"
        ? `Unknown key in the address file: ${issue.keys.join(", ")}. Allowed: ${ADDRESS_FIELDS.join(", ")}.`
        : `Invalid address file at ${at}.`);
    }
    return null;
  }
  if (Object.keys(parsed.data).length === 0) {
    io.log(`The address file names no address field. Allowed: ${ADDRESS_FIELDS.join(", ")}.`);
    return null;
  }
  return parsed.data;
}

function changeLine(change: Change, dryRun: boolean): string {
  if (change.kind === "unchanged") return `unchanged ${change.field} [profile]`;
  if (dryRun) return `would ${change.kind === "set" ? "set" : "clear"} ${change.field} [profile]`;
  return `${change.kind} ${change.field} [profile]`;
}

export async function runProfileAddress(argv: string[], deps: Partial<ProfileAddressDeps> = {}): Promise<number> {
  const io: ProfileAddressDeps = {
    open: deps.open ?? getProfileDatabase,
    close: deps.close ?? closeProfileDatabase,
    readFile: deps.readFile ?? ((path) => readFileSync(path, "utf8")),
    log: deps.log ?? ((line) => console.log(line)),
    lock: deps.lock ?? ((profile) => acquirePipelineLock(resolveProfileDataDirectory(profile)))
  };
  const args = parseArgs(argv);
  if (!args) {
    io.log(USAGE);
    return 2;
  }

  // The whole file is validated before the database is opened.
  let file: AddressFile | null = null;
  if (args.setFile) {
    file = readAddressFile(args.setFile, io);
    if (!file) return 1;
  }

  const database = io.open(args.profile);
  try {
    if (!file) {
      for (const line of listAddressLines(database)) io.log(line);
      return 0;
    }
    const candidate = getCandidate(database, LOCAL_CANDIDATE_ID);
    if (!candidate) {
      io.log("Save the candidate profile first; nothing was written.");
      return 1;
    }
    const preview = addressChanges(candidate, file);
    const changed = preview.filter((change) => change.kind !== "unchanged").length;
    if (args.dryRun || changed === 0) {
      for (const change of preview) io.log(changeLine(change, args.dryRun));
      io.log(changed === 0 ? "nothing to change" : `would change ${changed} address field${changed === 1 ? "" : "s"}`);
      return 0;
    }

    let release: (() => void) | null = null;
    try {
      release = io.lock(args.profile);
    } catch (error) {
      io.log(`Not saved: ${error instanceof Error ? error.message : "the pipeline lock could not be taken."}`);
      return 1;
    }
    try {
      // Re-read under the lock, then save the whole profile through the dashboard action's service.
      const current = getCandidate(database, LOCAL_CANDIDATE_ID);
      if (!current) {
        io.log("Save the candidate profile first; nothing was written.");
        return 1;
      }
      const changes = addressChanges(current, file);
      const next = changes.filter((change) => change.kind !== "unchanged");
      if (next.length > 0) {
        const updates: Partial<Record<AddressField, string | undefined>> = {};
        for (const change of next) updates[change.field] = change.value;
        try {
          updateCandidateProfile({ ...current, ...updates }, database);
        } catch (error) {
          if (error instanceof z.ZodError) {
            const paths = [...new Set(error.issues.map((issue) => issue.path.join(".") || "(root)"))];
            io.log(`Not saved: the saved profile does not pass the profile's checks at ${paths.join(", ")}; fix it on the profile page.`);
          } else {
            io.log("Not saved: the profile could not be written.");
          }
          return 1;
        }
      }
      for (const change of changes) io.log(changeLine(change, false));
      io.log(next.length === 0 ? "nothing to change" : `changed ${next.length} address field${next.length === 1 ? "" : "s"}`);
      return 0;
    } finally {
      release?.();
    }
  } finally {
    io.close(args.profile);
  }
}
