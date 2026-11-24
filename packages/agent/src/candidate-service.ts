import type { DatabaseSync } from "node:sqlite";

import {
  getCandidate,
  getCandidatePreferences,
  getCurrentFact,
  getCurrentFacts,
  getDatabase,
  LOCAL_CANDIDATE_ID,
  revokeCandidateFact,
  saveCandidate,
  saveCandidateFact,
  saveCandidatePreferences
} from "@internship-agent/db";
import {
  candidatePreferenceInputSchema,
  candidateProfileInputSchema,
  COURSEWORK_FACT_KEY,
  factDefinitions,
  formatFactValue,
  localCalendarDate,
  parseFactAnswer,
  rememberAnswerInputSchema,
  STANDARD_ANSWER_KEYS,
  type CandidatePreferenceInput,
  type CandidateProfileInput,
  type MappedQuestion,
  type QuestionContext,
  type QuestionResolution,
  type RememberAnswerInput
} from "@internship-agent/domain";

import { courseworkAnswerFact } from "./coursework";
import { DeterministicQuestionMapper, type SemanticQuestionMapper } from "./question-mapper";
import { resolveStandardAnswer } from "./standard-answers";

export function getCandidateWorkspace(database: DatabaseSync = getDatabase()) {
  return {
    candidate: getCandidate(database, LOCAL_CANDIDATE_ID),
    preferences: getCandidatePreferences(database, LOCAL_CANDIDATE_ID),
    facts: getCurrentFacts(database, LOCAL_CANDIDATE_ID)
  };
}

export function updateCandidateProfile(input: CandidateProfileInput, database: DatabaseSync = getDatabase()) {
  return saveCandidate(database, LOCAL_CANDIDATE_ID, candidateProfileInputSchema.parse(input));
}

export function updateCandidatePreferences(
  input: CandidatePreferenceInput,
  database: DatabaseSync = getDatabase()
) {
  return saveCandidatePreferences(database, LOCAL_CANDIDATE_ID, candidatePreferenceInputSchema.parse(input));
}

export async function resolveCandidateQuestion(
  question: string,
  context: QuestionContext = {},
  options: { database?: DatabaseSync; mapper?: SemanticQuestionMapper; today?: string } = {}
): Promise<QuestionResolution> {
  const database = options.database ?? getDatabase();
  const mapper = options.mapper ?? new DeterministicQuestionMapper();
  const mapping = await mapper.map(question, context);

  if (mapping.status === "BLOCKED") {
    return {
      status: "REQUIRES_CONFIRMATION",
      question,
      reason: mapping.reason,
      policy: mapping.policy
    };
  }
  if (mapping.status === "AMBIGUOUS") return { status: "AMBIGUOUS", question, reason: mapping.reason };
  if (mapping.status === "UNMAPPED") return { status: "UNMAPPED", question, reason: mapping.reason };
  if (factDefinitions[mapping.key].sensitivity === "protected") return protectedRefusal(question);

  // Relevant coursework is built from the saved courses, never read from candidate_facts.
  if (mapping.key === COURSEWORK_FACT_KEY) {
    const fact = courseworkAnswerFact(database, LOCAL_CANDIDATE_ID);
    if (!fact) {
      return {
        status: "NEEDS_INPUT",
        question,
        mapping,
        reason: "No coursework is saved; the candidate adds it with pnpm profile:coursework."
      };
    }
    return { status: "RESOLVED", question, mapping, fact, displayAnswer: formatFactValue(fact.value) };
  }

  // Standard legal and background answers built or dated at resolve time (standard-answers.ts).
  const today = options.today ?? localCalendarDate(new Date());
  const standard = resolveStandardAnswer(database, LOCAL_CANDIDATE_ID, question, mapping, context, today);
  if (standard) return narrowed(standard, mapping);

  // A channel- or company-scoped question may use the global answer when the
  // channel or company has none of its own. The reverse never happens: a
  // channel or company answer is not visible to global questions, other
  // channels, or other companies.
  const fact = getCurrentFact(database, LOCAL_CANDIDATE_ID, mapping.key, mapping.scope)
    ?? (mapping.scope.kind === "application_channel" || mapping.scope.kind === "company"
      ? getCurrentFact(database, LOCAL_CANDIDATE_ID, mapping.key, { kind: "global" })
      : null);
  if (!fact) {
    return {
      status: "NEEDS_INPUT",
      question,
      mapping,
      reason: `No remembered ${factDefinitions[mapping.key].label.toLocaleLowerCase("en-US")} fact exists for this scope.`
    };
  }
  if (fact.reusePolicy === "never" || fact.reusePolicy === "confirm") {
    return {
      status: "REQUIRES_CONFIRMATION",
      question,
      reason: "This fact's reuse policy requires direct confirmation.",
      policy: "fact_policy",
      fact
    };
  }
  return narrowed({
    status: "RESOLVED",
    question,
    mapping,
    fact,
    displayAnswer: formatFactValue(fact.value)
  }, mapping);
}

/** A question narrower than its saved fact ("a felony" for "a conviction") is answered only by a saved No. */
function narrowed(resolution: QuestionResolution, mapping: MappedQuestion): QuestionResolution {
  if (resolution.status === "RESOLVED" && mapping.narrower && resolution.fact.value === true) {
    return {
      status: "NEEDS_INPUT",
      question: resolution.question,
      mapping,
      reason: "Your saved Yes covers more than this question asks; answer it directly."
    };
  }
  return resolution;
}

export async function answerCandidateQuestion(
  input: RememberAnswerInput,
  options: { database?: DatabaseSync; mapper?: SemanticQuestionMapper } = {}
): Promise<QuestionResolution> {
  const parsed = rememberAnswerInputSchema.parse(input);
  const database = options.database ?? getDatabase();
  const mapper = options.mapper ?? new DeterministicQuestionMapper();
  const mapping = await mapper.map(parsed.question, parsed.context);

  if (mapping.status === "BLOCKED") {
    return {
      status: "REQUIRES_CONFIRMATION",
      question: parsed.question,
      reason: mapping.reason,
      policy: mapping.policy
    };
  }
  if (mapping.status === "AMBIGUOUS") return { status: "AMBIGUOUS", question: parsed.question, reason: mapping.reason };
  if (mapping.status === "UNMAPPED") return { status: "UNMAPPED", question: parsed.question, reason: mapping.reason };
  // Protected answers are saved only with pnpm profile:facts, never from a question.
  if (factDefinitions[mapping.key].sensitivity === "protected") return protectedRefusal(parsed.question);

  const value = parseFactAnswer(mapping.key, parsed.answer);
  if (mapping.key === COURSEWORK_FACT_KEY) {
    return {
      status: "ANSWERED_ONCE",
      question: parsed.question,
      mapping,
      displayAnswer: formatFactValue(value),
      reason: "Coursework is saved only with pnpm profile:coursework; this answer was used once."
    };
  }
  if (STANDARD_ANSWER_KEYS.has(mapping.key)) {
    return {
      status: "ANSWERED_ONCE",
      question: parsed.question,
      mapping,
      displayAnswer: formatFactValue(value),
      reason: "Legal and background answers are saved only with pnpm profile:facts; this answer was used once."
    };
  }
  if (!parsed.remember) {
    return {
      status: "ANSWERED_ONCE",
      question: parsed.question,
      mapping,
      displayAnswer: formatFactValue(value),
      reason: "This answer was not saved."
    };
  }
  if ((mapping.key === "previously_worked_here" || mapping.key === "relatives_at_company") &&
    value === true && mapping.scope.kind !== "company") {
    return {
      status: "ANSWERED_ONCE",
      question: parsed.question,
      mapping,
      displayAnswer: formatFactValue(value),
      reason: "A Yes here is saved only for a named company; this answer was used once."
    };
  }

  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    key: mapping.key,
    scope: mapping.scope,
    value,
    source: "user",
    sourceDetail: { kind: "remembered_answer", question: parsed.question },
    confidence: 1,
    rememberedAt: new Date().toISOString()
  });
  return resolveCandidateQuestion(parsed.question, parsed.context, { database, mapper });
}

function protectedRefusal(question: string): QuestionResolution {
  return {
    status: "REQUIRES_CONFIRMATION",
    question,
    reason: "Protected self-identification answers are used only in voluntary self-identification questions.",
    policy: "protected"
  };
}

export function forgetCandidateFact(factId: string, database: DatabaseSync = getDatabase()): boolean {
  return revokeCandidateFact(database, LOCAL_CANDIDATE_ID, factId);
}
