import { execFileSync } from "node:child_process";

const PATH_FEATURE_RULES = [
  { pattern: /^testing-harness\/(?:agent-|run|manifest)|^testing-harness\/support\/|^testing-harness\/harness\/|^package\.json$|^turbo\.json$/, features: ["agent-workflow", "foundation"] },
  { pattern: /^packages\/domain\/|^testing-harness\/domain\//, features: ["foundation", "profile", "remember"] },
  { pattern: /^packages\/db\/|^testing-harness\/db\/|^data\//, features: ["database", "foundation", "profile", "remember"] },
  { pattern: /^packages\/domain\/src\/(?:github|evidence)\.ts$|^packages\/db\/(?:migrations\/0003|src\/(?:github|evidence)-repository)|^packages\/github\/|^testing-harness\/github\//, features: ["github", "evidence"] },
  { pattern: /^packages\/agent\/|^testing-harness\/agent\//, features: ["profile", "remember"] },
  { pattern: /^packages\/jobs\//, features: ["foundation"] },
  { pattern: /^packages\/domain\/src\/matching\.ts$/, features: ["matching"] },
  { pattern: /^packages\/matching\/|^testing-harness\/matching\//, features: ["matching", "database"] },
  { pattern: /^apps\/dashboard\/(?:app\/jobs\/|components\/jobs\/MatchPanel)|^packages\/agent\/src\/match-orchestrator/, features: ["matching", "dashboard"] },
  { pattern: /^packages\/domain\/src\/application\.ts$/, features: ["writing", "verification"] },
  { pattern: /^packages\/(?:writer|resume)\/|^testing-harness\/writer\//, features: ["writing", "database"] },
  { pattern: /^packages\/verifier\/|^testing-harness\/verifier\//, features: ["verification", "database"] },
  { pattern: /^packages\/agent\/src\/application-orchestrator|^apps\/dashboard\/components\/jobs\/ApplicationPanel/, features: ["writing", "verification", "dashboard"] },
  { pattern: /^apps\/dashboard\/|^testing-harness\/browser\/|^testing-harness\/dashboard\/|^playwright\.config\./, features: ["dashboard", "profile", "remember"] },
  { pattern: /^apps\/dashboard\/(?:app\/(?:applications|review)\/|components\/(?:applications|overview)\/)/, features: ["dashboard", "applications"] },
  { pattern: /^packages\/domain\/src\/browser\.ts$/, features: ["browser"] },
  { pattern: /^packages\/browser\/|^testing-harness\/browser-worker\//, features: ["browser", "database"] },
  { pattern: /^packages\/agent\/src\/browser-orchestrator|^apps\/dashboard\/components\/applications\/(?:BrowserRunPanel|RunControls)|^testing-harness\/browser\/fixture/, features: ["browser", "dashboard", "applications"] },
  { pattern: /^apps\/dashboard\/(?:app\/evidence\/|components\/evidence\/)|^testing-harness\/browser\/github-evidence\.spec\.ts$/, features: ["github", "evidence"] },
  { pattern: /^(?:AGENTS|CLAUDE|TECHNICAL|ProjectStructure|PROJECT_CONTEXT|README|BUGS)\.md$|^docs\/|^bugs\/|^scripts\/(?:public-sync|split-docs)\.mjs$/, features: ["agent-workflow"] }
];

export function normalizeCliArgs(argv) {
  return argv.filter((argument) => argument !== "--");
}

export function selectChangedFeatures(paths) {
  const features = new Set();
  let requiresBuild = false;
  for (const path of paths) {
    if (/^apps\/dashboard\/|^packages\/|^package\.json$|^pnpm-lock\.yaml$|^turbo\.json$/.test(path)) requiresBuild = true;
    for (const rule of PATH_FEATURE_RULES) {
      if (rule.pattern.test(path)) rule.features.forEach((feature) => features.add(feature));
    }
  }
  if (paths.length > 0 && features.size === 0) features.add("agent-workflow");
  return { features: [...features].sort(), requiresBuild };
}

export function changedPaths(cwd) {
  const paths = new Set();
  try {
    const output = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    output.split(/\r?\n/).filter(Boolean).forEach((path) => paths.add(path));
  } catch {
    // A new repository without a first commit has no HEAD; untracked discovery below is sufficient.
  }
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" });
  untracked.split(/\r?\n/).filter(Boolean).forEach((path) => paths.add(path));
  return [...paths].sort();
}

export function requiredCapabilities(suites) {
  return [...new Set(suites.flatMap((suite) => suite.requires ?? []))].sort();
}
