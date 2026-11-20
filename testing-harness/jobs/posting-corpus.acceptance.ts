import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createDatabase, summarizeModelInvocations } from "@internship-agent/db";
import { verifyTextSpan } from "@internship-agent/domain";
import { getJobWorkspace, ingestJobPosting } from "@internship-agent/jobs";
import { selectClassifier } from "@internship-agent/agent";

/**
 * Milestone 3's exit criterion: several structurally different real postings
 * normalize reliably to one schema.
 *
 * Real postings are third-party content, so the corpus lives in a git-ignored
 * local directory the candidate fills. Each posting is a JSON file:
 *
 *   { "companyName": "...", "title": "...", "sourceUrl": "https://...",
 *     "externalApplicationUrl": null, "content": "<pasted posting text>" }
 *
 * This asserts structural reliability only. It reports what the classifier
 * decided; it never treats model output as ground truth. Judging whether the
 * hard/preferred split is *correct* is a human review step.
 */

const CORPUS_ENV = "INTERNSHIP_AGENT_POSTING_CORPUS";
const DEFAULT_CORPUS = "data/job-postings";
const MINIMUM_POSTINGS = 3;

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

type CorpusEntry = {
  file: string;
  companyName: string;
  title: string;
  sourceUrl: string;
  externalApplicationUrl?: string | null;
  companyCareersUrl?: string | null;
  content: string;
};

async function main(): Promise<void> {
  const corpusDirectory = resolve(process.env[CORPUS_ENV]?.trim() || DEFAULT_CORPUS);
  const entries = readCorpus(corpusDirectory);
  if (entries.length < MINIMUM_POSTINGS) {
    throw new Error(
      `Place at least ${MINIMUM_POSTINGS} posting JSON files in ${corpusDirectory} `
      + `(or set ${CORPUS_ENV}). Found ${entries.length}.`
    );
  }

  const directory = mkdtempSync(join(tmpdir(), "internship-agent-corpus-"));
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    database = createDatabase(join(directory, "corpus.sqlite"));
    const classifier = selectClassifier(database);
    const results = [];

    for (const entry of entries) {
      const report = await ingestJobPosting({
        companyName: entry.companyName,
        title: entry.title,
        content: entry.content,
        sourceUrl: entry.sourceUrl,
        externalApplicationUrl: entry.externalApplicationUrl ?? null,
        companyCareersUrl: entry.companyCareersUrl ?? null
      }, { database, classifier });

      if (report.rejectedSpans > 0) {
        throw new Error(`${entry.file}: ${report.rejectedSpans} extracted spans did not match the snapshot.`);
      }
      results.push({ file: entry.file, report });
    }

    const postings = getJobWorkspace(database).postings;
    if (postings.length !== entries.length) {
      throw new Error(`Expected ${entries.length} stored postings, found ${postings.length}.`);
    }

    for (const posting of postings) {
      const text = posting.snapshot.normalizedText;
      for (const requirement of posting.requirements) {
        if (!verifyTextSpan(text, requirement.span)) {
          throw new Error(`${posting.title}: a stored requirement is not anchored in its snapshot.`);
        }
        if (requirement.category === "HARD" && requirement.assertion !== "STATED") {
          throw new Error(`${posting.title}: a hard requirement is not stated by the posting.`);
        }
      }
      if (posting.requirements.length === 0) {
        throw new Error(`${posting.title}: produced no requirements, so normalization is not reliable for it.`);
      }
    }

    /*
     * A posting that states neither a hard requirement nor an eligibility
     * constraint is legitimate and common, so it is reported rather than
     * failed. It matters because Milestone 4 must not read "nothing failed"
     * as "qualified": with no stated gate there is nothing to decide on, and
     * a missed extraction looks identical to a posting that is simply silent.
     */
    const eligibility = postings.reduce((counts, posting) => {
      const hard = posting.requirements.some((requirement) => requirement.category === "HARD");
      const constrained = Object.values(posting.constraints).some((constraint) => constraint !== null);
      return {
        withHardRequirement: counts.withHardRequirement + (hard ? 1 : 0),
        withStatedConstraint: counts.withStatedConstraint + (constrained ? 1 : 0),
        withNoEligibilitySignal: counts.withNoEligibilitySignal + (!hard && !constrained ? 1 : 0)
      };
    }, { withHardRequirement: 0, withStatedConstraint: 0, withNoEligibilitySignal: 0 });

    const cost = summarizeModelInvocations(database);
    process.stdout.write(`JOB_POSTING_CORPUS_REPORT ${JSON.stringify({
      schemaVersion: 1,
      corpusDirectory,
      postings: results.length,
      classifier: results[0]?.report.classifier ?? "DETERMINISTIC",
      perPosting: results.map(({ file, report }) => ({
        file,
        hardRequirements: report.hardRequirements,
        preferredRequirements: report.preferredRequirements,
        technologies: report.technologies,
        locations: report.locations,
        statedConstraints: report.statedConstraints
      })),
      eligibility,
      modelInvocations: cost.invocations,
      modelInputTokens: cost.inputTokens,
      modelOutputTokens: cost.outputTokens,
      classificationReviewed: false,
      status: "passed"
    })}\n`);
  } finally {
    database?.close();
    if (!directory.startsWith(join(tmpdir(), "internship-agent-corpus-"))) {
      throw new Error("Refusing to clean an unexpected corpus verification directory.");
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function readCorpus(corpusDirectory: string): CorpusEntry[] {
  let files: string[];
  try {
    files = readdirSync(corpusDirectory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    throw new Error(`No posting corpus at ${corpusDirectory}. Create it, or set ${CORPUS_ENV}.`);
  }

  return files.map((file) => {
    const parsed = JSON.parse(readFileSync(join(corpusDirectory, file), "utf8")) as Partial<CorpusEntry>;
    for (const key of ["companyName", "title", "sourceUrl", "content"] as const) {
      if (typeof parsed[key] !== "string" || !parsed[key]?.trim()) {
        throw new Error(`${file} is missing a ${key} string.`);
      }
    }
    return { ...parsed, file } as CorpusEntry;
  });
}
