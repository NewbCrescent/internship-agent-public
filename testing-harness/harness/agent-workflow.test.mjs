import assert from "node:assert/strict";
import test from "node:test";

import { suiteManifest, validateSuiteManifest } from "../manifest.mjs";
import { selectChangedFeatures } from "../support/agent-workflow.mjs";

test("manifest suite ids and package scripts remain valid", async () => {
  const packageJson = (await import("../../package.json", { with: { type: "json" } })).default;
  assert.deepEqual(validateSuiteManifest(packageJson.scripts), []);
  assert.equal(new Set(suiteManifest.map((suite) => suite.id)).size, suiteManifest.length);
});

test("candidate domain and dashboard changes select their feature gates", () => {
  assert.deepEqual(
    selectChangedFeatures(["packages/domain/src/candidate-facts.ts"]).features,
    ["foundation", "profile", "remember"]
  );
  assert.deepEqual(
    selectChangedFeatures(["apps/dashboard/app/profile/page.tsx"]).features,
    ["dashboard", "profile", "remember"]
  );
  assert.deepEqual(
    selectChangedFeatures(["packages/github/src/evidence-service.ts"]).features,
    ["evidence", "github"]
  );
  assert.deepEqual(
    selectChangedFeatures(["apps/dashboard/app/evidence/page.tsx"]).features,
    ["dashboard", "evidence", "github", "profile", "remember"]
  );
});

test("docs, bug files, and the doc scripts select the agent-workflow gate", () => {
  assert.deepEqual(
    selectChangedFeatures(["docs/technical/06-job-posting-model/010-jobs-holds-posting-identity.md", "bugs/open/example-bug.md", "scripts/split-docs.mjs", "scripts/public-sync.mjs"]),
    { features: ["agent-workflow"], requiresBuild: false }
  );
  assert.deepEqual(
    selectChangedFeatures(["packages/domain/src/candidate-facts.ts", "bugs/open/example-bug.md"]).features,
    ["agent-workflow", "foundation", "profile", "remember"]
  );
});
