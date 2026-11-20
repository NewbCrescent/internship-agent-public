import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, getCoursework, LOCAL_CANDIDATE_ID, seedDevelopmentData } from "@internship-agent/db";
import { formatCourseworkAnswer, type CourseworkSet } from "@internship-agent/domain";

import { runProfileCoursework } from "../../packages/agent/src/coursework";

/**
 * `pnpm profile:coursework` against a disposable workspace. The courses here
 * are neutral fixtures (a fictional school, generic codes), never a real list.
 */
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-profile-coursework-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(join(directory, "test.sqlite"));
  seedDevelopmentData(database);
  const files = new Map<string, string>();
  const output: string[] = [];
  let opens = 0;
  let closes = 0;
  let acquired = 0;
  let released = 0;
  let lockError: string | null = null;
  const run = (argv: string[]) => runProfileCoursework(argv, {
    open: () => { opens += 1; return database; },
    close: () => { closes += 1; },
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error("missing");
      return text;
    },
    log: (line) => { output.push(line); },
    lock: () => {
      if (lockError) throw new Error(lockError);
      acquired += 1;
      return () => { released += 1; };
    }
  });
  return {
    database,
    files,
    output,
    run,
    counts: () => ({ opens, closes, acquired, released }),
    failLock: (message: string) => { lockError = message; }
  };
}

const contextVersion = (database: DatabaseSync) =>
  (database.prepare("SELECT version FROM semantic_fit_context WHERE id = 1").get() as { version: number }).version;
const courseCount = (database: DatabaseSync) =>
  (database.prepare("SELECT COUNT(*) AS count FROM candidate_coursework").get() as { count: number }).count;

const school = "Example State University";
const FILE: CourseworkSet = {
  school,
  courses: [
    { code: "CS 61B", title: "Data Structures", term: "Fall 2025", status: "completed" },
    { code: "CS 70", title: "Discrete Mathematics", term: "Fall 2025", status: "completed" },
    { code: "CS 189", title: "Machine Learning", term: "Spring 2026", status: "in_progress" }
  ]
};

describe("pnpm profile:coursework", () => {
  it("saves a set under the pipeline lock and prints what changed", async () => {
    const { database, files, output, run, counts } = workspace();
    files.set("coursework.json", JSON.stringify(FILE));
    expect(await run(["--profile", "demo", "--set-file", "coursework.json"])).toBe(0);
    expect(output).toEqual([
      `school: ${school}`,
      "added CS 61B: Data Structures (Fall 2025, completed)",
      "added CS 70: Discrete Mathematics (Fall 2025, completed)",
      "added CS 189: Machine Learning (Spring 2026, in progress)",
      "saved 3 courses (2 completed, 1 in progress)",
      `answer: ${formatCourseworkAnswer(FILE.courses)}`
    ]);
    expect(getCoursework(database, LOCAL_CANDIDATE_ID)).toMatchObject({ school, courses: FILE.courses });
    expect(counts()).toEqual({ opens: 1, closes: 1, acquired: 1, released: 1 });
    database.close();
  });

  it("skips an unchanged set and reports added, changed, and removed courses", async () => {
    const { database, files, output, run } = workspace();
    files.set("coursework.json", JSON.stringify(FILE));
    expect(await run(["--profile", "demo", "--set-file", "coursework.json"])).toBe(0);
    const version = contextVersion(database);
    output.length = 0;
    expect(await run(["--profile", "demo", "--set-file", "coursework.json"])).toBe(0);
    expect(output[0]).toBe("unchanged: 3 courses (2 completed, 1 in progress)");
    expect(contextVersion(database)).toBe(version);

    const changed: CourseworkSet = {
      school,
      courses: [
        { code: "CS 61B", title: "Data Structures", term: "Fall 2025", status: "completed" },
        { code: "CS 189", title: "Machine Learning", term: "Spring 2026", status: "completed" },
        { code: "CS 162", title: "Operating Systems", term: "Fall 2026", status: "in_progress" }
      ]
    };
    files.set("changed.json", JSON.stringify(changed));
    output.length = 0;
    expect(await run(["--profile", "demo", "--set-file", "changed.json"])).toBe(0);
    expect(output).toEqual([
      "added CS 162: Operating Systems (Fall 2026, in progress)",
      "changed CS 189: Machine Learning (Spring 2026, completed)",
      "removed CS 70: Discrete Mathematics",
      "saved 3 courses (2 completed, 1 in progress)",
      `answer: ${formatCourseworkAnswer(changed.courses)}`
    ]);
    expect(getCoursework(database, LOCAL_CANDIDATE_ID)?.courses).toEqual(changed.courses);
    expect(contextVersion(database)).toBeGreaterThan(version);
    database.close();
  });

  it("treats a re-cased code as a change and stores the new spelling", async () => {
    const { database, files, output, run } = workspace();
    files.set("coursework.json", JSON.stringify(FILE));
    expect(await run(["--profile", "demo", "--set-file", "coursework.json"])).toBe(0);
    const recased = { school, courses: FILE.courses.map((course) => course.code === "CS 70" ? { ...course, code: "cs 70" } : course) };
    files.set("recased.json", JSON.stringify(recased));
    output.length = 0;
    expect(await run(["--profile", "demo", "--set-file", "recased.json"])).toBe(0);
    expect(output.some((line) => line.startsWith("unchanged"))).toBe(false);
    expect(output).toContain("changed cs 70: Discrete Mathematics (Fall 2025, completed)");
    expect(getCoursework(database, LOCAL_CANDIDATE_ID)?.courses.map((course) => course.code)).toEqual(["CS 61B", "cs 70", "CS 189"]);
    database.close();
  });

  it("reports a reordered set", async () => {
    const { database, files, output, run } = workspace();
    files.set("coursework.json", JSON.stringify(FILE));
    expect(await run(["--profile", "demo", "--set-file", "coursework.json"])).toBe(0);
    files.set("reordered.json", JSON.stringify({ school, courses: [...FILE.courses].reverse() }));
    output.length = 0;
    expect(await run(["--profile", "demo", "--set-file", "reordered.json"])).toBe(0);
    expect(output[0]).toBe("reordered courses");
    expect(getCoursework(database, LOCAL_CANDIDATE_ID)?.courses.map((course) => course.code)).toEqual(["CS 189", "CS 70", "CS 61B"]);
    database.close();
  });

  it("writes nothing and takes no lock on a dry run", async () => {
    const { database, files, output, run, counts } = workspace();
    files.set("coursework.json", JSON.stringify(FILE));
    const version = contextVersion(database);
    expect(await run(["--profile", "demo", "--set-file", "coursework.json", "--dry-run"])).toBe(0);
    expect(output).toContain("would added CS 61B: Data Structures (Fall 2025, completed)");
    expect(output).toContain("would saved 3 courses (2 completed, 1 in progress)");
    expect(courseCount(database)).toBe(0);
    expect(contextVersion(database)).toBe(version);
    expect(counts().acquired).toBe(0);
    database.close();
  });

  it("validates the whole file before opening the database", async () => {
    const { database, files, output, run, counts } = workspace();
    const valid = FILE.courses[0]!;
    const invalid: Array<[string, string, string]> = [
      ["grade.json", JSON.stringify({ school, courses: [{ ...valid, grade: "A" }] }), "Invalid coursework file at courses.0"],
      ["status.json", JSON.stringify({ school, courses: [{ ...valid, status: "done" }] }), "Invalid coursework file at courses.0.status"],
      ["duplicate.json", JSON.stringify({ school, courses: [valid, { ...valid, code: "cs 61b" }] }), "Invalid coursework file at courses.1.code"],
      ["id.json", JSON.stringify({ school, courses: [{ ...valid, title: "Data Structures 123456789" }] }), "Invalid coursework file at courses.0.title"],
      ["school.json", JSON.stringify({ courses: [valid] }), "Invalid coursework file at school"],
      ["many.json", JSON.stringify({ school, courses: Array.from({ length: 41 }, (_, index) => ({ ...valid, code: `CS ${index}` })) }), "Invalid coursework file at courses"],
      ["text.json", "not json", "The coursework file is not valid JSON."]
    ];
    for (const [path, text, expected] of invalid) {
      files.set(path, text);
      output.length = 0;
      expect(await run(["--profile", "demo", "--set-file", path]), path).toBe(1);
      expect(output.some((line) => line.startsWith(expected)), `${path}: ${output.join(" | ")}`).toBe(true);
    }
    output.length = 0;
    expect(await run(["--profile", "demo", "--set-file", "missing.json"])).toBe(1);
    expect(output).toEqual(["The coursework file could not be read."]);
    expect(counts().opens).toBe(0);
    expect(courseCount(database)).toBe(0);
    database.close();
  });

  it("refuses to write while a pipeline run holds the lock", async () => {
    const { database, files, output, run, failLock } = workspace();
    files.set("coursework.json", JSON.stringify(FILE));
    failLock("A pipeline run is already in progress (process 1, started 2026-11-19T00:00:00.000Z).");
    expect(await run(["--profile", "demo", "--set-file", "coursework.json"])).toBe(1);
    expect(output).toEqual(["A pipeline run is already in progress (process 1, started 2026-11-19T00:00:00.000Z)."]);
    expect(courseCount(database)).toBe(0);
    database.close();
  });

  it("lists the saved courses", async () => {
    const { database, files, output, run } = workspace();
    expect(await run(["--profile", "demo"])).toBe(0);
    expect(output).toEqual(["No coursework is saved for this workspace."]);
    files.set("coursework.json", JSON.stringify(FILE));
    expect(await run(["--profile", "demo", "--set-file", "coursework.json"])).toBe(0);
    output.length = 0;
    expect(await run(["--profile", "demo", "--list"])).toBe(0);
    expect(output).toEqual([
      `school: ${school}`,
      "CS 61B | Data Structures | Fall 2025 | completed",
      "CS 70 | Discrete Mathematics | Fall 2025 | completed",
      "CS 189 | Machine Learning | Spring 2026 | in progress",
      `answer: ${formatCourseworkAnswer(FILE.courses)}`
    ]);
    output.length = 0;
    expect(await run(["--profile", "demo"])).toBe(0);
    expect(output[0]).toBe(`school: ${school}`);
    database.close();
  });

  it("clears the set with an empty course list", async () => {
    const { database, files, output, run } = workspace();
    files.set("coursework.json", JSON.stringify(FILE));
    expect(await run(["--profile", "demo", "--set-file", "coursework.json"])).toBe(0);
    files.set("empty.json", JSON.stringify({ school, courses: [] }));
    output.length = 0;
    expect(await run(["--profile", "demo", "--set-file", "empty.json"])).toBe(0);
    expect(output).toContain("removed CS 61B: Data Structures");
    expect(output).toContain("cleared all courses");
    expect(output).toContain("answer: none");
    expect(getCoursework(database, LOCAL_CANDIDATE_ID)).toBeNull();
    database.close();
  });

  it("prints usage for bad arguments", async () => {
    const { database, output, run, counts } = workspace();
    for (const argv of [[], ["--list"], ["--profile", "demo", "--list", "--set-file", "x"], ["--profile", "demo", "--dry-run"], ["--profile", "demo", "--unknown"], ["--profile", "elsewhere"], ["--profile", "demo", "--set-file"]]) {
      output.length = 0;
      expect(await run(argv), argv.join(" ")).toBe(2);
      expect(output[0]).toMatch(/^Usage: pnpm profile:coursework/);
    }
    expect(counts().opens).toBe(0);
    database.close();
  });
});
