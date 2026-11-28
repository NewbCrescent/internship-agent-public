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
  availabilityWindowHold,
  candidatePreferenceInputSchema,
  candidateProfileInputSchema,
  COURSEWORK_FACT_KEY,
  factDefinitions,
  formatFactValue,
  localCalendarDate,
  parseFactAnswer,
  relocationQuestionParts,
  rememberAnswerInputSchema,
  STANDARD_ANSWER_KEYS,
  type CandidatePreferenceInput,
  type CandidateProfileInput,
  type MappedQuestion,
  type QuestionContext,
  type QuestionResolution,
  type RememberAnswerInput,
  withoutCoveredTerm,
  type AvailabilityWindow
} from "@internship-agent/domain";

import { courseworkAnswerFact } from "./coursework";
import { DeterministicQuestionMapper, placeInUnitedStates, type SemanticQuestionMapper } from "./question-mapper";
import { formerEmployerNamed, resolveStandardAnswer } from "./standard-answers";

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

  // Age thresholds answer each other one way only (Track 57): a saved 18-or-older Yes answers a 16-or-older question, and a saved
  // 16-or-older No answers an 18-or-older question; an 18-or-older No or a 16-or-older Yes answers nothing else. The fill names the saved fact it came from.
  if ((mapping.key === "age_16_or_older" || mapping.key === "age_18_or_older") && !getCurrentFact(database, LOCAL_CANDIDATE_ID, mapping.key, { kind: "global" })) {
    const other = getCurrentFact(database, LOCAL_CANDIDATE_ID, mapping.key === "age_16_or_older" ? "age_18_or_older" : "age_16_or_older", { kind: "global" });
    const implied = mapping.key === "age_16_or_older" ? other?.value === true : other?.value === false;
    if (other && implied && other.reusePolicy === "auto") {
      return { status: "RESOLVED", question, mapping, fact: other, displayAnswer: formatFactValue(other.value) };
    }
  }

  // (Track 83) An ACT score question with no saved score: a saved "did not take the ACT" answers it (the planner picks
  // the list's one "did not take" option, never a score). A saved act_score always wins; a score is never derived.
  if (mapping.key === "act_score" && !getCurrentFact(database, LOCAL_CANDIDATE_ID, "act_score", { kind: "global" })) {
    const taken = getCurrentFact(database, LOCAL_CANDIDATE_ID, "act_taken", { kind: "global" });
    if (taken && taken.value === false && taken.source === "user" && taken.reusePolicy === "auto") {
      return { status: "RESOLVED", question, mapping, fact: taken, displayAnswer: formatFactValue(taken.value) };
    }
  }

  // A channel- or company-scoped question may use the global answer when the
  // channel or company has none of its own. The reverse never happens: a
  // channel or company answer is not visible to global questions, other
  // channels, or other companies. A relocation question naming a U.S. place
  // may use the saved U.S.-wide relocation Yes of the same key, plain or at
  // own expense (usWideRelocationFact, Track 83).
  const fact = getCurrentFact(database, LOCAL_CANDIDATE_ID, mapping.key, mapping.scope)
    ?? (mapping.scope.kind === "application_channel" || mapping.scope.kind === "company"
      ? getCurrentFact(database, LOCAL_CANDIDATE_ID, mapping.key, { kind: "global" })
      : null)
    ?? usWideRelocationFact(database, mapping, context);
  if (!fact) {
    return {
      status: "NEEDS_INPUT",
      question,
      mapping,
      reason: `No remembered ${factDefinitions[mapping.key].label.toLocaleLowerCase("en-US")} fact exists for this scope.`
    };
  }
  // A relocation question that also asks something the saved relocation answer does not settle stays with the candidate
  // (Track 62); the own-expense question gets the same check, without the who-pays part its answer settles (Track 83).
  if (mapping.key === "willing_to_relocate" || mapping.key === "willing_to_relocate_at_own_expense") {
    const held = relocationPartsHold(database, question, mapping.key === "willing_to_relocate_at_own_expense");
    if (held) return { status: "NEEDS_INPUT", question, mapping, reason: held };
  }
  // (Track 83) A full-time availability question stating dates or a length is answered only inside the saved window.
  if (mapping.key === "available_full_time" && typeof fact.value === "boolean") {
    const held = availabilityWindowHold(question, savedAvailabilityWindow(database), fact.value);
    if (held) return { status: "NEEDS_INPUT", question, mapping, reason: held };
  }
  // A No never answers a previous-employment question that names a company the candidate has a saved Yes for.
  if (mapping.key === "previously_worked_here" && fact.value === false && formerEmployerNamed(database, LOCAL_CANDIDATE_ID, question)) {
    return { status: "NEEDS_INPUT", question, mapping, reason: "The question names a company you worked for; answer it yourself." };
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

/**
 * The saved U.S.-wide relocation Yes for a relocation question naming a place inside the United States (Track 62;
 * the candidate's words, 2026-11-27: "Yes I would relocate anywhere in the US"). One way only: the place's own
 * answer is read first, a city answer never answers the country, a saved No never widens, and a place in another or
 * an unknown country gets nothing. The own-expense question reads the saved U.S. own-expense answer, never the plain
 * one (Track 83).
 */
function usWideRelocationFact(database: DatabaseSync, mapping: MappedQuestion, context: QuestionContext) {
  if (mapping.key !== "willing_to_relocate" && mapping.key !== "willing_to_relocate_at_own_expense") return null;
  if (mapping.scope.kind !== "location") return null;
  if (!placeInUnitedStates(mapping.scope.name, context)) return null;
  const fact = getCurrentFact(database, LOCAL_CANDIDATE_ID, mapping.key, { kind: "country", code: "US" });
  return fact && fact.value === true && fact.source === "user" ? fact : null;
}

/** (Track 83) The saved internship availability window (global, user-sourced), as ISO dates; null where not saved. */
function savedAvailabilityWindow(database: DatabaseSync): { start: string | null; end: string | null } {
  const read = (key: "available_start_date" | "available_end_date") => {
    const fact = getCurrentFact(database, LOCAL_CANDIDATE_ID, key, { kind: "global" });
    return fact && fact.source === "user" && typeof fact.value === "string" ? fact.value : null;
  };
  return { start: read("available_start_date"), end: read("available_end_date") };
}

/**
 * (Track 89) The saved availability window for answering questions: like savedAvailabilityWindow, but a date whose
 * fact the candidate did not save for automatic reuse reads as null, so nothing is answered from it.
 */
export function reusableAvailabilityWindow(database: DatabaseSync): AvailabilityWindow {
  const read = (key: "available_start_date" | "available_end_date") => {
    const fact = getCurrentFact(database, LOCAL_CANDIDATE_ID, key, { kind: "global" });
    return fact && fact.source === "user" && fact.reusePolicy === "auto" && typeof fact.value === "string" ? fact.value : null;
  };
  return { start: read("available_start_date"), end: read("available_end_date") };
}

/**
 * Why a relocation question's other parts keep it paused (Track 62): a temporary or permanent move, who pays,
 * stated dates, remote work, or living nearby not joined by "or" (relocationQuestionParts), or an on-site part
 * without a saved Yes to on-site work. Null when only the relocation part is left. `ownExpense` drops the who-pays
 * part, which the own-expense answer settles (Track 83).
 */
function relocationPartsHold(database: DatabaseSync, question: string, ownExpense: boolean): string | null {
  // (Track 89) The summer term and spans the saved window covers ("(June-August)", "(Summer 2027)") are not other parts.
  const parts = relocationQuestionParts(withoutCoveredTerm(question, reusableAvailabilityWindow(database)), { ownExpense });
  if (parts.held) return parts.held;
  if (parts.onSite) {
    const onSite = getCurrentFact(database, LOCAL_CANDIDATE_ID, "work_arrangement", { kind: "global" });
    if (!onSite || onSite.value !== true || onSite.reusePolicy !== "auto") {
      return "It also asks about working on site, and no saved answer says you are open to it.";
    }
  }
  return null;
}

/**
 * A question narrower than its saved fact ("a felony" for "a conviction") is answered only by a saved No;
 * a question broader than it ("a current student" for full-time enrollment) only by a saved Yes.
 */
function narrowed(resolution: QuestionResolution, mapping: MappedQuestion): QuestionResolution {
  if (resolution.status === "RESOLVED" && mapping.narrower && resolution.fact.value === true) {
    return {
      status: "NEEDS_INPUT",
      question: resolution.question,
      mapping,
      reason: "Your saved Yes covers more than this question asks; answer it directly."
    };
  }
  if (resolution.status === "RESOLVED" && mapping.broader && resolution.fact.value === false) {
    return {
      status: "NEEDS_INPUT",
      question: resolution.question,
      mapping,
      reason: "Your saved No covers less than this question asks; answer it directly."
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
  if (mapping.broader) {
    return {
      status: "ANSWERED_ONCE",
      question: parsed.question,
      mapping,
      displayAnswer: formatFactValue(value),
      reason: "The question asks more than the saved fact; this answer was used once."
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
