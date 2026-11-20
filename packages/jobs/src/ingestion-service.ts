import type { DatabaseSync } from "node:sqlite";

import {
  getDatabase,
  getJobPosting,
  listJobPostings,
  listJobSummaries,
  persistNormalizedPosting,
  type NormalizedPostingInput,
  type PlaceAndPay
} from "@internship-agent/db";
import {
  jobIngestionInputSchema,
  verifyTextSpan,
  type Assertion,
  type JobIngestionInput,
  type JobPosting,
  type JobPostingStatus
} from "@internship-agent/domain";

import { extractDeterministically, type DeterministicExtraction, type RequirementCandidate } from "./deterministic-extractor";
import { classifyApplicationType, classifyEmploymentType } from "./posting-source";
import {
  DeterministicRequirementClassifier,
  RequirementLabelsUnavailableError,
  type ClassificationContext,
  type ClassifiedRequirement,
  type RequirementClassifier
} from "./requirement-classifier";
import { contentHash, normalizePostingText } from "./text-normalizer";

export type IngestionReport = {
  jobId: string;
  status: "CREATED" | "REVISED" | "UNCHANGED";
  classifier: RequirementClassifier["method"];
  hardRequirements: number;
  preferredRequirements: number;
  technologies: number;
  locations: number;
  statedConstraints: string[];
  /** Extracted spans dropped because they did not match the snapshot text. */
  rejectedSpans: number;
  /** Why the model could not label the requirements; the posting is held. Null when labelled. */
  requirementLabelsPending: string | null;
};

export type IngestOptions = {
  database?: DatabaseSync;
  classifier?: RequirementClassifier;
  protectedStatuses?: ReadonlySet<JobPostingStatus>;
};

/**
 * Location and pay read from stored posting text, keeping only spans that
 * quote it. Ingestion and the extraction backfill share this one reading.
 */
export function extractPlaceAndPay(normalizedText: string): PlaceAndPay {
  return verifiedPlaceAndPay(normalizedText, extractDeterministically(normalizedText));
}

function verifiedPlaceAndPay(normalizedText: string, extraction: DeterministicExtraction): PlaceAndPay {
  return {
    locations: extraction.locations.filter((location) => verifyTextSpan(normalizedText, location.span)),
    compensation: extraction.compensation && verifyTextSpan(normalizedText, extraction.compensation.span)
      ? extraction.compensation
      : null
  };
}

export async function ingestJobPosting(
  input: JobIngestionInput,
  options: IngestOptions = {}
): Promise<IngestionReport> {
  const database = options.database ?? getDatabase();
  const classifier = options.classifier ?? new DeterministicRequirementClassifier();
  const validated = jobIngestionInputSchema.parse(input);

  const normalizedText = normalizePostingText(validated.content);
  if (!normalizedText) throw new Error("The posting content is empty after normalization.");

  const extraction = extractDeterministically(normalizedText);
  const externalApplicationUrl = validated.externalApplicationUrl ?? null;

  let requirements: NormalizedPostingInput["requirements"];
  let rejectedSpans: number;
  let labelsPending: string | null = null;
  try {
    ({ requirements, rejectedSpans } = await labelRequirements(normalizedText, extraction.requirements, classifier, {
      title: validated.title,
      companyName: validated.companyName,
      jobId: null,
      sourceUrl: validated.sourceUrl
    }));
  } catch (error) {
    if (!isLabelsUnavailable(error)) throw error;
    // The posting is still stored, without requirement rows, and held until
    // the model labels its requirement lines. No rule label stands in.
    labelsPending = error.message;
    requirements = [];
    rejectedSpans = extraction.requirements
      .filter((candidate) => !verifyTextSpan(normalizedText, candidate.span)).length;
  }

  const posting: NormalizedPostingInput = {
    companyName: validated.companyName,
    title: validated.title,
    employmentType: classifyEmploymentType(validated.title, normalizedText),
    applicationType: classifyApplicationType(validated.sourceUrl, externalApplicationUrl),
    sourceUrl: validated.sourceUrl,
    externalApplicationUrl,
    companyCareersUrl: validated.companyCareersUrl ?? null,
    publication: validated.publication ?? null,
    contentHash: contentHash(normalizedText),
    normalizedText,
    ...verifiedPlaceAndPay(normalizedText, extraction),
    requirements,
    technologies: extraction.technologies.filter((technology) => verifyTextSpan(normalizedText, technology.span)),
    constraints: verifyConstraints(normalizedText, extraction.constraints),
    requirementLabelsPending: labelsPending
  };

  const result = persistNormalizedPosting(database, posting, {
    protectedStatuses: options.protectedStatuses
  });
  return {
    jobId: result.jobId,
    status: result.status,
    classifier: classifier.method,
    hardRequirements: requirements.filter((requirement) => requirement.category === "HARD").length,
    preferredRequirements: requirements.filter((requirement) => requirement.category === "PREFERRED").length,
    technologies: posting.technologies.length,
    locations: posting.locations.length,
    statedConstraints: Object.entries(posting.constraints)
      .filter(([, value]) => value !== null)
      .map(([kind]) => kind),
    rejectedSpans,
    requirementLabelsPending: labelsPending
  };
}

/** Classify extracted requirement lines and pass them through the span gate. */
export async function labelRequirements(
  normalizedText: string,
  candidates: RequirementCandidate[],
  classifier: RequirementClassifier,
  context: ClassificationContext
): Promise<{ requirements: NormalizedPostingInput["requirements"]; rejectedSpans: number }> {
  const classified = await classifier.classify(candidates, context);
  return resolveRequirements(normalizedText, candidates, classified, classifier.method);
}

function isLabelsUnavailable(error: unknown): error is Error {
  return error instanceof RequirementLabelsUnavailableError
    || (error instanceof Error && error.name === "RequirementLabelsUnavailableError");
}

/**
 * The single gate every requirement passes through.
 *
 * Spans come from the deterministic extractor and are re-verified against the
 * snapshot before persisting. A classifier returns only indices and labels, so
 * it can never move a span or introduce a quotation the posting does not
 * contain. What a classifier *can* do is report an ungrounded reading as
 * `INFERRED`, which is forced down to `PREFERRED` here and blocked from `HARD`
 * by the domain schema and the table's own CHECK constraint.
 *
 * A model classifier must label every span-verified candidate; a missing
 * decision holds the posting instead of keeping the rule label.
 */
function resolveRequirements(
  normalizedText: string,
  candidates: RequirementCandidate[],
  classified: ClassifiedRequirement[],
  method: RequirementClassifier["method"]
): { requirements: NormalizedPostingInput["requirements"]; rejectedSpans: number } {
  const decisions = new Map(classified.map((decision) => [decision.index, decision]));
  const requirements: NormalizedPostingInput["requirements"] = [];
  let rejectedSpans = 0;

  candidates.forEach((candidate, index) => {
    if (!verifyTextSpan(normalizedText, candidate.span)) {
      rejectedSpans += 1;
      return;
    }
    const decision = decisions.get(index);
    if (!decision && method === "MODEL") {
      throw new RequirementLabelsUnavailableError("the model left a requirement unlabelled");
    }
    const assertion: Assertion = decision?.assertion ?? "STATED";
    const category = decision?.category ?? candidate.category;
    requirements.push({
      text: candidate.text,
      category: assertion === "STATED" ? category : "PREFERRED",
      subject: decision?.subject ?? candidate.subject,
      extraction: decision ? method : "DETERMINISTIC",
      assertion,
      confidence: clampConfidence(decision?.confidence ?? candidate.confidence),
      span: candidate.span
    });
  });

  return { requirements, rejectedSpans };
}

function clampConfidence(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function verifyConstraints(
  normalizedText: string,
  constraints: NormalizedPostingInput["constraints"]
): NormalizedPostingInput["constraints"] {
  const verified = { ...constraints };
  for (const kind of ["graduation", "authorization", "sponsorship", "availability"] as const) {
    const constraint = verified[kind];
    if (constraint && !verifyTextSpan(normalizedText, constraint.span)) {
      verified[kind] = null;
    }
  }
  return verified;
}

export function getJobWorkspace(database: DatabaseSync = getDatabase()) {
  return { postings: listJobPostings(database) };
}

export function getJobs(database: DatabaseSync = getDatabase()) {
  return listJobSummaries(database);
}

export function getPosting(jobId: string, database: DatabaseSync = getDatabase()): JobPosting | null {
  return getJobPosting(database, jobId);
}
