import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import {
  closeProfileDatabase,
  getCandidate,
  getCurrentFact,
  getCurrentFacts,
  getProfileDatabase,
  LOCAL_CANDIDATE_ID,
  revokeCandidateFact,
  saveCandidateFact,
  setCandidatePreferredName,
  supersedeCandidateFact
} from "@internship-agent/db";
import {
  candidateFactKeySchema,
  candidateFactSchema,
  COURSEWORK_FACT_KEY,
  factDefinitions,
  factScopeSchema,
  formatFactValue,
  isStandardAnswerKey,
  scopeKey,
  standardAnswersFileSchema,
  workspaceProfileSchema,
  type CandidateFactKey,
  type CandidateFactValue,
  type FactScope,
  type StandardAnswersFile,
  type WorkspaceProfile
} from "@internship-agent/domain";
import { z } from "zod";

import { formerEmployerNamed, standardAnswerFactFile } from "./standard-answers";

/**
 * `pnpm profile:facts`: writes the candidate's explicitly given answers as
 * facts with source "user" and provenance. The whole file is validated
 * before anything is written; protected answers (voluntary
 * self-identification) are never printed, not even in errors — they show as
 * "set".
 *
 * It also accepts the standard legal and background answers file
 * (standardAnswersFileSchema, packages/domain standard-answers.ts): an object
 * of the candidate's answers by key, such as
 * { "us_citizen": <true | false>, "non_solicitation": { "answer": <true | false>, "ends": "<YYYY-MM-DD>", ... }, "preferred_first_name": "<name>", ... }.
 * Each answer is saved as its catalog fact (the 50-mile answer scoped to
 * San Francisco only), the preferred first name goes to the profile, and
 * every saved value prints only as "set". Unknown keys fail, naming the key.
 */
// Built at resolve time from other saved answers; never written by a fact file.
const NOT_STORED = [COURSEWORK_FACT_KEY, "us_person", "us_citizen_or_national", "us_citizen_or_permanent_resident", "salary_expectation"] as const;

export const factFileSchema = z.object({
  facts: z.array(z.object({
    key: candidateFactKeySchema.exclude(NOT_STORED),
    scope: factScopeSchema.default({ kind: "global" }),
    value: z.union([z.boolean(), z.string()]),
    note: z.string().trim().min(1).max(500).optional()
  }).strict()).max(100).default([]),
  revoke: z.array(z.object({
    key: candidateFactKeySchema.exclude(NOT_STORED),
    scope: factScopeSchema.default({ kind: "global" })
  }).strict()).max(100).default([])
}).strict();

export type FactFile = z.infer<typeof factFileSchema>;

export type ProfileFactsDeps = {
  open(profile: WorkspaceProfile): DatabaseSync;
  close(profile: WorkspaceProfile): void;
  readFile(path: string): string;
  log(line: string): void;
};

const USAGE = "Usage: pnpm profile:facts --profile real|demo [--set-file <facts.json>] [--dry-run]";

function shown(key: CandidateFactKey, value: CandidateFactValue): string {
  return factDefinitions[key].sensitivity === "protected" || isStandardAnswerKey(key) ? "set" : formatFactValue(value);
}

function scopeLabel(scope: FactScope): string {
  try {
    return scopeKey(scope);
  } catch {
    return "unknown scope";
  }
}

export function applyFactFile(
  database: DatabaseSync,
  file: FactFile,
  options: { dryRun: boolean; candidateId?: string }
): { ok: boolean; lines: string[] } {
  const candidateId = options.candidateId ?? LOCAL_CANDIDATE_ID;
  const lines: string[] = [];
  const now = new Date().toISOString();

  // Validate every entry before any write.
  for (const entry of file.facts) {
    const definition = factDefinitions[entry.key];
    const result = candidateFactSchema.safeParse({
      id: "validation",
      candidateId,
      key: entry.key,
      scope: entry.scope,
      value: entry.value,
      valueType: definition.valueType,
      source: "user",
      sourceDetail: { kind: "profile" },
      confidence: 1,
      sensitivity: definition.sensitivity,
      reusePolicy: definition.reusePolicy,
      rememberedAt: now,
      createdAt: now,
      supersededAt: null,
      supersededById: null,
      revokedAt: null
    });
    if (!result.success) lines.push(`invalid: ${entry.key} [${scopeLabel(entry.scope)}]: value or scope not allowed`);
  }
  if (lines.length > 0) return { ok: false, lines };

  const prefix = options.dryRun ? "would " : "";
  for (const entry of file.facts) {
    const label = scopeKey(entry.scope);
    const current = getCurrentFact(database, candidateId, entry.key, entry.scope);
    let countryFactId: string | null = null;
    let countryFactWritten = false;
    if (current && JSON.stringify(current.value) === JSON.stringify(entry.value)) {
      lines.push(`unchanged ${entry.key} [${label}]: ${shown(entry.key, entry.value)}`);
      countryFactId = current.id;
      countryFactWritten = true;
    } else {
      if (!options.dryRun) {
        const saved = saveCandidateFact(database, {
          candidateId,
          key: entry.key,
          scope: entry.scope,
          value: entry.value,
          source: "user",
          sourceDetail: { kind: "profile", question: entry.note ?? `Saved with pnpm profile:facts: ${factDefinitions[entry.key].label}` },
          confidence: 1,
          rememberedAt: new Date().toISOString()
        });
        countryFactId = saved.id;
        countryFactWritten = true;
      }
      lines.push(`${prefix}set ${entry.key} [${label}]: ${shown(entry.key, entry.value)}`);
    }

    // A country relocation answer replaces the old global one.
    if (entry.key === "willing_to_relocate" && entry.scope.kind === "country") {
      const global = getCurrentFact(database, candidateId, "willing_to_relocate", { kind: "global" });
      if (global) {
        if (!options.dryRun && countryFactWritten && countryFactId) {
          supersedeCandidateFact(database, candidateId, global.id, countryFactId);
          lines.push(`superseded willing_to_relocate [global] by [${label}]`);
        } else {
          lines.push(`would supersede willing_to_relocate [global] by [${label}]`);
        }
      }
    }
  }

  for (const entry of file.revoke) {
    const label = scopeKey(entry.scope);
    const current = getCurrentFact(database, candidateId, entry.key, entry.scope);
    if (!current) {
      lines.push(`not found ${entry.key} [${label}]`);
      continue;
    }
    if (!options.dryRun) revokeCandidateFact(database, candidateId, current.id);
    lines.push(`${prefix}revoked ${entry.key} [${label}]`);
  }
  return { ok: true, lines };
}

export function listFacts(database: DatabaseSync, candidateId: string = LOCAL_CANDIDATE_ID): string[] {
  return getCurrentFacts(database, candidateId)
    .map((fact) => `${fact.key} [${scopeKey(fact.scope)}]: ${shown(fact.key, fact.value)}`);
}

type ParsedArgs = { profile: WorkspaceProfile; setFile: string | null; dryRun: boolean };

function parseArgs(argv: string[]): ParsedArgs | null {
  let profile: string | null = null;
  let setFile: string | null = null;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") profile = argv[++index] ?? null;
    else if (arg === "--set-file") {
      setFile = argv[++index] ?? null;
      if (!setFile) return null;
    } else if (arg === "--dry-run") dryRun = true;
    else return null;
  }
  const parsed = workspaceProfileSchema.safeParse(profile);
  return parsed.success ? { profile: parsed.data, setFile, dryRun } : null;
}

export async function runProfileFacts(argv: string[], deps: Partial<ProfileFactsDeps> = {}): Promise<number> {
  const io: ProfileFactsDeps = {
    open: deps.open ?? getProfileDatabase,
    close: deps.close ?? closeProfileDatabase,
    readFile: deps.readFile ?? ((path) => readFileSync(path, "utf8")),
    log: deps.log ?? ((line) => console.log(line))
  };
  const args = parseArgs(argv);
  if (!args) {
    io.log(USAGE);
    return 2;
  }

  let file: FactFile | null = null;
  let standard: StandardAnswersFile | null = null;
  if (args.setFile) {
    let text: string;
    try {
      text = io.readFile(args.setFile);
    } catch {
      io.log("The fact file could not be read.");
      return 1;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      io.log("The fact file is not valid JSON.");
      return 1;
    }
    const factShape = typeof raw === "object" && raw !== null && !Array.isArray(raw) && ("facts" in raw || "revoke" in raw);
    if (factShape) {
      const parsed = factFileSchema.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) io.log(`Invalid fact file at ${issue.path.join(".") || "(root)"}.`);
        return 1;
      }
      file = parsed.data;
    } else {
      // The standard answers file: only key names and paths are printed, never values.
      const parsed = standardAnswersFileSchema.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const at = issue.path.join(".") || "(root)";
          io.log(issue.code === "unrecognized_keys"
            ? `Unknown key in the standard answers file at ${at}: ${issue.keys.join(", ")}.`
            : `Invalid standard answers file at ${at}.`);
        }
        return 1;
      }
      standard = parsed.data;
    }
  }

  const database = io.open(args.profile);
  try {
    if (standard) return applyStandardAnswers(database, standard, { dryRun: args.dryRun, log: io.log });
    if (!file) {
      for (const line of listFacts(database)) io.log(line);
      return 0;
    }
    const result = applyFactFile(database, file, { dryRun: args.dryRun });
    for (const line of result.lines) io.log(line);
    return result.ok ? 0 : 1;
  } finally {
    io.close(args.profile);
  }
}

/** Saves the standard answers file: its facts through applyFactFile, then the preferred first name on the profile. */
function applyStandardAnswers(
  database: DatabaseSync,
  data: StandardAnswersFile,
  options: { dryRun: boolean; log: (line: string) => void }
): number {
  const candidate = getCandidate(database, LOCAL_CANDIDATE_ID);
  if (!candidate) {
    options.log("The workspace has no candidate profile; nothing was written.");
    return 1;
  }
  if (data.non_solicitation.answer && formerEmployerNamed(database, LOCAL_CANDIDATE_ID, data.non_solicitation.explanation)) {
    options.log("invalid: the non-solicitation explanation names a former employer saved in your facts; nothing was written.");
    return 1;
  }
  const result = applyFactFile(database, standardAnswerFactFile(data), { dryRun: options.dryRun });
  for (const line of result.lines) options.log(line);
  if (!result.ok) return 1;
  const preferredName = data.preferred_first_name;
  if (options.dryRun) {
    options.log(candidate.preferredName === preferredName ? "unchanged preferred name [profile]: set" : "would set preferred name [profile]: set");
    return 0;
  }
  const outcome = setCandidatePreferredName(database, LOCAL_CANDIDATE_ID, preferredName);
  if (outcome === "missing") {
    options.log("The workspace has no candidate profile; the preferred name was not written.");
    return 1;
  }
  options.log(outcome === "set" ? "set preferred name [profile]: set" : "unchanged preferred name [profile]: set");
  return 0;
}
