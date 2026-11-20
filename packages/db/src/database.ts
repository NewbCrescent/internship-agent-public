import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { workspaceProfileSchema, type WorkspaceProfile } from "@internship-agent/domain";

function findRepositoryRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml")) && existsSync(join(current, "PROJECT_CONTEXT.md"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("Could not locate the internship-agent repository root.");
    current = parent;
  }
}

export function resolveDatabasePath(): string {
  const dataDirectory = process.env.INTERNSHIP_AGENT_DATA_DIR?.trim()
    ? resolve(process.env.INTERNSHIP_AGENT_DATA_DIR)
    : join(findRepositoryRoot(), "data");
  mkdirSync(dataDirectory, { recursive: true });
  return join(dataDirectory, "internship-agent.sqlite");
}

export function resolveProfileDatabasePath(profile: WorkspaceProfile): string {
  const parsed = workspaceProfileSchema.parse(profile);
  const demoPath = resolveDatabasePath();
  return parsed === "demo" ? demoPath : join(dirname(demoPath), "profiles", "real", "internship-agent.sqlite");
}

export function resolveProfileDataDirectory(profile: WorkspaceProfile): string {
  return dirname(resolveProfileDatabasePath(profile));
}

export function createDatabase(databasePath = resolveDatabasePath()): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA journal_mode = WAL;");
  runMigrations(database);
  return database;
}

function runMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const migrationDirectory = join(findRepositoryRoot(), "packages", "db", "migrations");
  const appliedRows = database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>;
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const file of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationDirectory, file), "utf8");
    database.exec("BEGIN IMMEDIATE;");
    try {
      database.exec(sql);
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(file, new Date().toISOString());
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
}

const databaseSymbol = Symbol.for("internship-agent.database");
type DatabaseGlobal = typeof globalThis & { [databaseSymbol]?: DatabaseSync };

export function getDatabase(): DatabaseSync {
  const databaseGlobal = globalThis as DatabaseGlobal;
  databaseGlobal[databaseSymbol] ??= createDatabase();
  return databaseGlobal[databaseSymbol];
}

const realDatabaseSymbol = Symbol.for("internship-agent.database.real");
type ProfileDatabaseGlobal = typeof globalThis & { [realDatabaseSymbol]?: DatabaseSync };

export function getProfileDatabase(profile: WorkspaceProfile): DatabaseSync {
  const parsed = workspaceProfileSchema.parse(profile);
  if (parsed === "demo") return getDatabase();
  const databaseGlobal = globalThis as ProfileDatabaseGlobal;
  databaseGlobal[realDatabaseSymbol] ??= createDatabase(resolveProfileDatabasePath("real"));
  return databaseGlobal[realDatabaseSymbol];
}

/**
 * Closes the workspace's cached handle, if open, and forgets it, so the next
 * getProfileDatabase opens a fresh one. For scripts that finish with the
 * database; closing the cached handle directly would leave every later
 * caller in the process holding a closed one.
 */
export function closeProfileDatabase(profile: WorkspaceProfile): void {
  const parsed = workspaceProfileSchema.parse(profile);
  const databaseGlobal = globalThis as DatabaseGlobal & ProfileDatabaseGlobal;
  const cached = parsed === "demo" ? databaseGlobal[databaseSymbol] : databaseGlobal[realDatabaseSymbol];
  if (parsed === "demo") delete databaseGlobal[databaseSymbol];
  else delete databaseGlobal[realDatabaseSymbol];
  if (cached?.isOpen) cached.close();
}
