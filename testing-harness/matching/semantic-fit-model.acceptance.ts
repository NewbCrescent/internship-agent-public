import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, seedDevelopmentData, listJobSummaries, getJobStatus } from "@internship-agent/db";
import { analyzeSemanticFit, evaluateAndPersistMatch } from "@internship-agent/agent";

// Live-provider transport/grounding smoke, using fictional seed data only.
// Model output is review material, never a human accuracy label.
async function main() {
const directory = mkdtempSync(join(tmpdir(), "internship-fit-model-smoke-"));
const database = createDatabase(join(directory, "test.sqlite"));
try {
  seedDevelopmentData(database);
  const jobId = listJobSummaries(database)[0].id;
  evaluateAndPersistMatch(jobId, { database });
  const status = getJobStatus(database, jobId);
  const assessment = await analyzeSemanticFit(jobId, { database });
  if (getJobStatus(database, jobId) !== status) throw new Error("AI changed application state.");
  process.stdout.write(`SEMANTIC_FIT_MODEL_REPORT ${JSON.stringify({ schemaVersion: 1, status: "passed", model: assessment.model,
    rating: assessment.version === 2 ? assessment.rating : "legacy", confidence: assessment.version === 2 ? assessment.confidence : "unknown", score: assessment.score, unknown: assessment.unknownCount,
    counts: assessment.decisions.reduce<Record<string, number>>((counts, d) => ({ ...counts, [d.assessment]: (counts[d.assessment] ?? 0) + 1 }), {}),
    accuracyValidated: false, syntheticOnly: true })}\n`);
} finally { database.close(); rmSync(directory, { recursive: true, force: true }); }

}
main().catch(() => { process.stderr.write("SEMANTIC_FIT_MODEL_REPORT {\"status\":\"failed\",\"syntheticOnly\":true}\n"); process.exitCode = 1; });
