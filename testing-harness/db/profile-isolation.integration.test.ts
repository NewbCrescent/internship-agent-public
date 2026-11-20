import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDatabase,
  getCandidate,
  LOCAL_CANDIDATE_ID,
  resolveProfileDatabasePath,
  saveCandidate,
  seedBrowserEvidenceData
} from "@internship-agent/db";

describe("profile database isolation", () => {
  it("keeps the existing demo data and a real candidate in separate local files", () => {
    const directory = mkdtempSync(join(tmpdir(), "internship-agent-profiles-"));
    const previous = process.env.INTERNSHIP_AGENT_DATA_DIR;
    process.env.INTERNSHIP_AGENT_DATA_DIR = directory;
    let demo: ReturnType<typeof createDatabase> | undefined;
    let real: ReturnType<typeof createDatabase> | undefined;
    try {
      const demoPath = resolveProfileDatabasePath("demo");
      const realPath = resolveProfileDatabasePath("real");
      expect(realPath).not.toBe(demoPath);
      demo = createDatabase(demoPath);
      real = createDatabase(realPath);
      seedBrowserEvidenceData(demo);

      expect(getCandidate(demo, LOCAL_CANDIDATE_ID)?.fullName).toBe("Jordan Rivera");
      expect(getCandidate(real, LOCAL_CANDIDATE_ID)).toBeNull();
      expect(demo.prepare("SELECT count(*) AS n FROM jobs").get()).toMatchObject({ n: 1 });
      expect(real.prepare("SELECT count(*) AS n FROM jobs").get()).toMatchObject({ n: 0 });
      expect(demo.prepare("SELECT count(*) AS n FROM github_repositories").get()).toMatchObject({ n: 1 });
      expect(real.prepare("SELECT count(*) AS n FROM github_repositories").get()).toMatchObject({ n: 0 });

      saveCandidate(real, LOCAL_CANDIDATE_ID, { fullName: "Casey Test" });
      expect(getCandidate(real, LOCAL_CANDIDATE_ID)?.fullName).toBe("Casey Test");
      expect(getCandidate(demo, LOCAL_CANDIDATE_ID)?.fullName).toBe("Jordan Rivera");
    } finally {
      demo?.close();
      real?.close();
      if (previous === undefined) delete process.env.INTERNSHIP_AGENT_DATA_DIR;
      else process.env.INTERNSHIP_AGENT_DATA_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
