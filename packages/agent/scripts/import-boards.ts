import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { closeProfileDatabase, getProfileDatabase, openApplicationAuditDatabase, resolveProfileDatabasePath } from "@internship-agent/db";
import { workspaceProfileSchema, type WorkspaceProfile } from "@internship-agent/domain";

import { formatBoardImportReport, importBoardSources } from "../src/board-import";

/**
 * Imports a reviewed JSON list of public boards as discovery sources. The
 * workspace and file are required, so an import is never aimed at the real
 * workspace by accident; --dry-run opens the database read-only.
 */
const USAGE = "Usage: pnpm sources:import-boards --profile real|demo --file <json> [--dry-run]";
const MAX_FILE_BYTES = 5_000_000;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let profileValue: string | undefined;
  let file: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--dry-run") { dryRun = true; continue; }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) usage();
    if (flag === "--profile") profileValue = value;
    else if (flag === "--file") file = value;
    else usage();
    index += 1;
  }
  if (profileValue === undefined || file === undefined) usage();
  const parsedProfile = workspaceProfileSchema.safeParse(profileValue);
  if (!parsedProfile.success) usage();
  const profile: WorkspaceProfile = parsedProfile.data;

  if (statSync(file).size > MAX_FILE_BYTES) throw new Error(`The file is larger than ${MAX_FILE_BYTES} bytes.`);
  const rows = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(rows)) throw new Error("The file must hold a JSON array of board rows.");

  let database: DatabaseSync;
  if (dryRun) {
    const path = resolveProfileDatabasePath(profile);
    if (!existsSync(path)) throw new Error(`No ${profile} workspace database at ${path}.`);
    database = openApplicationAuditDatabase(profile);
  } else {
    database = getProfileDatabase(profile);
  }
  try {
    const report = importBoardSources(database, rows, { dryRun, importedFrom: "scout run (" + basename(file) + ")" });
    for (const line of formatBoardImportReport(report, { profile, file })) console.log(line);
  } finally {
    if (dryRun) database.close();
    else closeProfileDatabase(profile);
  }
}

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
