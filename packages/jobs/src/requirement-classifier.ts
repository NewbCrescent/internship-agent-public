import type { Assertion, RequirementCategory, RequirementSubject } from "@internship-agent/domain";

import type { RequirementCandidate } from "./deterministic-extractor";

export type ClassifiedRequirement = {
  /** Index into the candidate array the classifier was given. */
  index: number;
  category: RequirementCategory;
  subject: RequirementSubject;
  /**
   * `INFERRED` is how a classifier reports that it read between the lines. The
   * domain schema then forbids the requirement from being hard, so an
   * ungrounded reading can never rule the candidate out in Milestone 4.
   */
  assertion: Assertion;
  confidence: number;
};

/**
 * Implemented deterministically here and, optionally, by a model-backed
 * classifier in `packages/agent`. Mirrors the injection used for
 * `GitHubClient` and `SemanticQuestionMapper`: `packages/jobs` never imports a
 * provider, so every fast and local suite runs offline by construction.
 *
 * A classifier only re-categorizes candidates it is given. It cannot invent a
 * requirement, and it cannot move a span, so its output stays anchored to text
 * the posting actually contains.
 *
 * A `MODEL` classifier returns one decision per candidate or throws
 * `RequirementLabelsUnavailableError`. It never substitutes rule labels: the
 * posting is then stored without requirement rows and held for a retry.
 */
export interface RequirementClassifier {
  readonly method: "DETERMINISTIC" | "MODEL";
  classify(candidates: RequirementCandidate[], context: ClassificationContext): Promise<ClassifiedRequirement[]>;
}

/** The stable prefix of every "labels unavailable" reason and notice. */
export const REQUIREMENT_LABELS_UNAVAILABLE = "AI requirement labels unavailable; will retry";

/** The model could not label every requirement line of a posting. */
export class RequirementLabelsUnavailableError extends Error {
  constructor(readonly causeText: string) {
    super(`${REQUIREMENT_LABELS_UNAVAILABLE} (${causeText}).`);
    this.name = "RequirementLabelsUnavailableError";
  }
}

/** A posting is held for AI labels, so it cannot be analyzed or prepared yet. */
export class RequirementLabelsPendingError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RequirementLabelsPendingError";
  }
}

export type ClassificationContext = {
  title: string;
  companyName: string;
  jobId: string | null;
  sourceUrl?: string | null;
};

export class DeterministicRequirementClassifier implements RequirementClassifier {
  readonly method = "DETERMINISTIC" as const;

  /** Echoes literal extracted text, so every decision is stated by the posting. */
  async classify(candidates: RequirementCandidate[]): Promise<ClassifiedRequirement[]> {
    return candidates.map((candidate, index) => ({
      index,
      category: candidate.category,
      subject: candidate.subject,
      assertion: "STATED" as const,
      confidence: candidate.confidence
    }));
  }
}
