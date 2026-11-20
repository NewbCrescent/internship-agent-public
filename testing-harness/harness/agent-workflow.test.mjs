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
