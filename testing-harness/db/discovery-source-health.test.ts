import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  listDiscoverySources,
  saveDiscoverySource,
  saveImportedBoardSources,
  updateDiscoverySourceHealth
} from "@internship-agent/db";

/**
 * Imported boards' provenance and fetch health (migration 0037) against
 * disposable SQLite: defaults for existing rows, atomic imported-board saves,
 * the health round trip, and rows from a database without 0037 still parsing.
 * Fictional companies only.
 */

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-source-health-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

const board = (slug: string, label = "Kestrel Freight " + slug) => ({
  label, url: "https://boards.greenhouse.io/" + slug, importedFrom: "scout run (boards.json)",
  importedAt: "2026-11-26T10:00:00.000Z", evidenceUrl: "https://kestrel.example.com/careers/" + slug
});

describe("discovery source health (migration 0037)", () => {
  it("is applied and gives existing sources no provenance and a clean health", () => {
    const database = disposableDatabase();
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = '0037_discovery_source_health.sql'").get()).toBeTruthy();
    const saved = saveDiscoverySource(database, { kind: "company-page", label: "Juniper Analytics", url: "https://jobs.lever.co/juniper", rateLimitPerMinute: 6 });
    expect(saved).toMatchObject({ importedFrom: null, importedAt: null, evidenceUrl: null, failureCount: 0, lastError: null, retryAfter: null });
    expect(listDiscoverySources(database)).toEqual([saved]);
    database.close();
  });

  it("saves imported boards with their provenance, or none of them when one fails", () => {
    const database = disposableDatabase();
    const saved = saveImportedBoardSources(database, [board("kestrel"), board("osprey")]);
    expect(saved).toHaveLength(2);
    const listed = listDiscoverySources(database);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({
      kind: "company-page", label: "Kestrel Freight kestrel", url: "https://boards.greenhouse.io/kestrel", rateLimitPerMinute: 6,
      enabled: true, createdAt: "2026-11-26T10:00:00.000Z", importedFrom: "scout run (boards.json)",
      importedAt: "2026-11-26T10:00:00.000Z", evidenceUrl: "https://kestrel.example.com/careers/kestrel", failureCount: 0
    });
    // A label over 160 characters in the middle of the batch fails it; nothing from it is saved.
    expect(() => saveImportedBoardSources(database, [board("wren"), board("heron", "x".repeat(161)), board("plover")])).toThrow();
    expect(listDiscoverySources(database).map((source) => source.url)).toEqual([
      "https://boards.greenhouse.io/kestrel", "https://boards.greenhouse.io/osprey"
    ]);
    database.close();
  });

  it("records and clears a board's fetch health", () => {
    const database = disposableDatabase();
    const [source] = saveImportedBoardSources(database, [board("kestrel")]);
    updateDiscoverySourceHealth(database, source!.id, {
      failureCount: 3, lastError: "The public board answered 503. " + "x".repeat(600), retryAfter: "2026-11-30T10:00:00.000Z"
    });
    const failing = listDiscoverySources(database)[0]!;
    expect(failing.failureCount).toBe(3);
    expect(failing.lastError).toHaveLength(500);
    expect(failing.lastError?.startsWith("The public board answered 503.")).toBe(true);
    expect(failing.retryAfter).toBe("2026-11-30T10:00:00.000Z");
    updateDiscoverySourceHealth(database, source!.id, { failureCount: 0, lastError: null, retryAfter: null });
    expect(listDiscoverySources(database)[0]).toMatchObject({ failureCount: 0, lastError: null, retryAfter: null });
    database.close();
  });

  it("reads sources from a database without migration 0037 with the defaults", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE discovery_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('manual-batch', 'company-page')),
        label TEXT NOT NULL,
        url TEXT,
        rate_limit_per_minute INTEGER NOT NULL CHECK (rate_limit_per_minute >= 1),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        last_fetched_at TEXT
      );
      INSERT INTO discovery_sources VALUES ('9f0c2f4e-0000-4000-8000-000000000001', 'company-page', 'Simplify Summer 2027',
        'https://github.com/SimplifyJobs/Summer2027-Internships', 1, 1, '2026-11-01T00:00:00.000Z', NULL);
    `);
    expect(listDiscoverySources(database)).toEqual([{
      id: "9f0c2f4e-0000-4000-8000-000000000001", kind: "company-page", label: "Simplify Summer 2027",
      url: "https://github.com/SimplifyJobs/Summer2027-Internships", rateLimitPerMinute: 1, enabled: true,
      createdAt: "2026-11-01T00:00:00.000Z", lastFetchedAt: null, importedFrom: null, importedAt: null, evidenceUrl: null,
      failureCount: 0, lastError: null, retryAfter: null
    }]);
    database.close();
  });
});
