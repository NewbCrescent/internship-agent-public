import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";
import { loadVoiceCorpus } from "@internship-agent/voice";

/**
 * Copies the candidate's writing-voice material into the workspace's
 * Git-ignored data directory. The evaluation holdout is never copied, so
 * drafting can never see it.
 *
 *   pnpm voice:import [--profile real|demo] [--from <references dir>]
 */
const FILES = ["reference-dataset.jsonl", "voice-profile.md", "category-guide.md", "audit-rubric.md", "authorship-gate.md"];

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const profile = workspaceProfileSchema.parse(option("--profile") ?? "real");
const from = resolve(option("--from") ?? join(homedir(), ".codex/skills/my-writing-voice/references"));
const target = process.env.INTERNSHIP_AGENT_VOICE_DIR?.trim() || join(resolveProfileDataDirectory(profile), "voice");

if (!loadVoiceCorpus(from)) {
  console.error(`No complete voice corpus at ${from}; it needs ${FILES.join(", ")}.`);
  process.exit(1);
}
mkdirSync(target, { recursive: true });
for (const file of FILES) copyFileSync(join(from, file), join(target, file));
const corpus = loadVoiceCorpus(target)!;
console.log(`Copied ${corpus.records.length} reference pieces and the voice guides to ${target} (evaluation holdout excluded).`);
