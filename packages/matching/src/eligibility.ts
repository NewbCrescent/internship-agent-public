import type { CandidateFact, CandidatePreference, JobPosting, JobRequirement } from "@internship-agent/domain";
import {
  applicationChannelFor,
  scopeKey,
  type ApplicationChannel,
  type CandidateFactKey,
  type FactScope
} from "@internship-agent/domain";
import type { EligibilityFinding } from "@internship-agent/domain";

import {
  acceptsBachelorLevel,
  bachelorKindMismatch,
  readBachelorDegreeRequirement,
  withoutPlaceAndTeamCodes,
  type DegreeContext,
  type TitleContext
} from "./degree-reading";
import { checkSchoolRestriction } from "./school-restriction";
import { displaySkillKey, mentionedAs } from "./skill-keys";

/**
 * Deterministic hard-eligibility checks. STATED hard requirements, STATED
 * constraints, and explicit candidate exclusions can fail. INFERRED readings
 * and silent fields never become eligibility facts.
 */
export type EligibilityInputs = {
  facts: CandidateFact[];
  preferences: CandidatePreference | null;
  /** Profile degree text; absent means degree checks pause, never fail. */
  candidateDegree: string | null;
  /** Profile field of study; absent means the field is read from the degree text. */
  candidateField?: string | null;
  /** Profile school; compared with postings stated to be for one school's students. */
  candidateSchool?: string | null;
  /** Canonical skill keys backed by ALLOWED + CURRENT evidence. */
  evidencedTechnologies: string[];
  /** Skills the candidate's approved resume entries name (skill lines and bullet technologies). */
  resumeSkills?: string[];
};

/** Stored reason of an open skill or experience requirement no evidence or resume names (compared byte for byte). */
export const SKILL_REVIEW_REASON = "Neither verified evidence nor your resume names this skill yet, so it needs your review rather than a failure.";
/** Stored reason of a degree line the deterministic comparison cannot settle (compared byte for byte). */
export const DEGREE_WORDING_REVIEW_REASON = "Degree wording needs candidate review; deterministic text comparison would over-fail.";
/** Stored reason of a degree line that asks for doctoral study (compared byte for byte). */
export const DOCTORAL_STUDY_REVIEW_REASON = "The posting requires doctoral study, which the recorded degree does not establish; candidate review is needed.";
/** Stored reason of a degree line that asks for master's study (compared byte for byte). */
export const MASTER_STUDY_REVIEW_REASON = "The posting requires master's study, which the recorded degree does not establish; candidate review is needed.";

export function evaluateEligibility(
  posting: JobPosting,
  inputs: EligibilityInputs
): EligibilityFinding[] {
  const findings: EligibilityFinding[] = [];
  const byKey = indexFacts(inputs.facts);
  const graduateExclusion = checkGraduateInternshipPreference(posting, inputs.preferences);
  if (graduateExclusion) findings.push(graduateExclusion);
  const school = checkSchoolRestriction(posting, inputs.candidateSchool ?? null);
  if (school) findings.push(school);

  const graduation = posting.constraints.graduation;
  const fullTime = lookup(byKey, "enrolled_full_time", { kind: "global" });
  const degree = (requirement: JobRequirement) => checkDegree(requirement.id, requirement.text, inputs.candidateDegree, {
    candidateField: inputs.candidateField ?? null,
    graduationChecked: graduation !== null,
    fullTimeStudent: typeof fullTime?.value === "boolean" ? fullTime.value : null
  });
  if (graduation) {
    findings.push(checkGraduation(
      graduation.earliest,
      graduation.latest,
      graduation.raw,
      byKey,
      applicationChannelFor(posting.source.applicationType)
    ));
  }
  const authorization = posting.constraints.authorization;
  if (authorization) {
    findings.push(
      checkBooleanFact(
        byKey,
        "authorized_to_work",
        { kind: "country", code: authorization.countryCode ?? "US" },
        "authorization",
        null,
        authorization.raw,
        (authorized) =>
          authorization.requiresExistingAuthorization && !authorized
            ? {
                failed: true,
                reason: "The posting requires existing work authorization, and the candidate is not authorized."
              }
            : { failed: false, reason: "Work authorization satisfies the posting requirement." }
      )
    );
  }
  const sponsorship = posting.constraints.sponsorship;
  if (sponsorship) {
    findings.push(
      checkBooleanFact(
        byKey,
        "requires_sponsorship",
        { kind: "country", code: sponsorship.countryCode ?? "US" },
        "sponsorship",
        null,
        sponsorship.raw,
        (needsSponsorship) =>
          !sponsorship.sponsorshipAvailable && needsSponsorship
            ? {
                failed: true,
                reason: "The posting states sponsorship is unavailable, and the candidate requires sponsorship."
              }
            : { failed: false, reason: "Sponsorship need is compatible with the posting." }
      )
    );
  }
  const availability = posting.constraints.availability;
  if (availability) {
    findings.push(
      checkDateFact(
        byKey,
        "available_start_date",
        "availability",
        null,
        availability.raw,
        [{ kind: "global" }],
        (start) =>
          inWindow(start, availability.earliestStart, availability.latestStart)
            ? { outcome: "PASS", reason: "The candidate's available start date fits the posting window." }
            : {
                outcome: "FAIL",
                reason: `The candidate's available start date (${start}) falls outside the posting window.`
              }
      )
    );
  }

  for (const requirement of posting.requirements) {
    if (requirement.category !== "HARD" || requirement.assertion !== "STATED") continue;
    const location = posting.locations.find((candidate) =>
      requirement.span.excerpt.includes(candidate.raw)
    );
    if (requirement.subject === "LOCATION" && location?.city) {
      findings.push(checkLocation(requirement.id, requirement.text, location.city, location.countryCode ?? null, byKey, inputs.preferences));
    } else if (requirement.subject !== "DEGREE" && namesGraduateStudy(requirement)) {
      // The model may label "Currently enrolled in an MBA" as graduation or
      // experience; the degree check reads the text, not the label.
      if (requirement.id !== graduateExclusion?.requirementId) findings.push(degree(requirement));
    } else if (requirement.subject === "SKILL" || requirement.subject === "EXPERIENCE") {
      // Evidence-backed skills pass; unevidenced ones pause. Neither fails:
      // failing for an unevidenced skill would confuse a missing preference
      // with a failed requirement.
      findings.push(checkSkill(requirement.id, requirement.subject, requirement.text, inputs.evidencedTechnologies, inputs.resumeSkills ?? []));
    } else if (requirement.subject === "DEGREE" && requirement.id !== graduateExclusion?.requirementId) {
      findings.push(degree(requirement));
    }
    // GRADUATION / AUTHORIZATION / AVAILABILITY subjects duplicate the
    // constraint checks above and carry no independent finding.
  }

  return findings;
}

function indexFacts(facts: CandidateFact[]): Map<string, CandidateFact> {
  const indexed = new Map<string, CandidateFact>();
  for (const fact of facts) {
    indexed.set(`${fact.key}|${scopeKey(fact.scope)}`, fact);
  }
  return indexed;
}

function lookup(
  byKey: Map<string, CandidateFact>,
  key: CandidateFactKey,
  scope: FactScope
): CandidateFact | null {
  return byKey.get(`${key}|${scopeKey(scope)}`) ?? null;
}

function checkGraduation(
  earliest: string | null,
  latest: string | null,
  raw: string,
  byKey: Map<string, CandidateFact>,
  channel: ApplicationChannel | null
): EligibilityFinding {
  // A channel-specific graduation answer applies only to that channel's
  // postings, ahead of the global answer.
  const scopes: FactScope[] = channel
    ? [{ kind: "application_channel", channel }, { kind: "global" }]
    : [{ kind: "global" }];
  return checkDateFact(byKey, "graduation_date", "graduation", null, raw, scopes, (graduation) =>
    inWindow(graduation, earliest, latest)
      ? { outcome: "PASS", reason: "The candidate's graduation date fits the posting window." }
      : {
          outcome: "FAIL",
          reason: `The candidate's graduation date (${graduation}) falls outside the posting window.`
        }
  );
}

function checkDateFact(
  byKey: Map<string, CandidateFact>,
  key: CandidateFactKey,
  subject: string,
  requirementId: string | null,
  raw: string,
  scopes: FactScope[],
  decide: (value: string) => { outcome: "PASS" | "FAIL"; reason: string }
): EligibilityFinding {
  for (const scope of scopes) {
    const fact = lookup(byKey, key, scope);
    if (fact && typeof fact.value === "string") {
      const decision = decide(fact.value);
      return {
        subject,
        requirementId,
        outcome: decision.outcome,
        reason: decision.reason,
        statedExcerpt: decision.outcome === "FAIL" ? raw.slice(0, 600) : null
      };
    }
  }
  return {
    subject,
    requirementId,
    outcome: "UNKNOWN",
    reason: "The candidate has not recorded this fact, so eligibility cannot be decided here.",
    statedExcerpt: null
  };
}

function checkBooleanFact(
  byKey: Map<string, CandidateFact>,
  key: CandidateFactKey,
  scope: FactScope,
  subject: string,
  requirementId: string | null,
  raw: string,
  decide: (value: boolean) => { failed: boolean; reason: string }
): EligibilityFinding {
  const fact = lookup(byKey, key, scope) ?? lookup(byKey, key, { kind: "global" });
  if (!fact || typeof fact.value !== "boolean") {
    return {
      subject,
      requirementId,
      outcome: "UNKNOWN",
      reason: "The candidate has not recorded this fact, so eligibility cannot be decided here.",
      statedExcerpt: null
    };
  }
  const decision = decide(fact.value);
  return {
    subject,
    requirementId,
    outcome: decision.failed ? "FAIL" : "PASS",
    reason: decision.reason,
    statedExcerpt: decision.failed ? raw.slice(0, 600) : null
  };
}

function checkLocation(
  requirementId: string,
  text: string,
  city: string,
  countryCode: string | null,
  byKey: Map<string, CandidateFact>,
  preferences: CandidatePreference | null
): EligibilityFinding {
  // The place's own answer, then the answer for its country, then the legacy global one.
  const scoped = lookup(byKey, "willing_to_relocate", { kind: "location", name: city });
  const country = countryCode ? lookup(byKey, "willing_to_relocate", { kind: "country", code: countryCode }) : null;
  const global = lookup(byKey, "willing_to_relocate", { kind: "global" });
  const willingness = scoped ?? country ?? global;
  if (willingness && willingness.value === false) {
    const preferred = preferences?.locations.some((place) =>
      place.toLocaleLowerCase("en-US").includes(city.toLocaleLowerCase("en-US"))
    );
    if (!preferred) {
      return {
        subject: "LOCATION",
        requirementId,
        outcome: "FAIL",
        reason: `The candidate is not willing to relocate to ${city}, which the posting requires.`,
        statedExcerpt: text.slice(0, 600)
      };
    }
  }
  if (!willingness) {
    return {
      subject: "LOCATION",
      requirementId,
      outcome: "UNKNOWN",
      reason: `Relocation willingness for ${city} is not recorded, so location eligibility needs review.`,
      statedExcerpt: null
    };
  }
  return {
    subject: "LOCATION",
    requirementId,
    outcome: "PASS",
    reason: `Location requirement (${city}) is compatible with the candidate's recorded willingness.`,
    statedExcerpt: null
  };
}

function checkSkill(
  requirementId: string,
  subject: "SKILL" | "EXPERIENCE",
  text: string,
  evidencedTechnologies: string[],
  resumeSkills: string[]
): EligibilityFinding {
  const evidenced = evidencedTechnologies.find((key) => mentionedAs(text, displaySkillKey(key)));
  if (evidenced) {
    return {
      subject,
      requirementId,
      outcome: "PASS",
      reason: "Verified evidence backs a skill this requirement names.",
      statedExcerpt: null
    };
  }
  // The candidate chose to let their own resume meet hard skill requirements.
  // A listed skill also covers its other names and the broader skill it is a
  // kind of ("PostgreSQL" meets "SQL").
  // Each term is reported once: "AWS (as cloud infrastructure)", not also EC2 and S3.
  const terms = new Set<string>();
  const listed = resumeSkills.flatMap((skill) => {
    const term = mentionedAs(text, skill);
    if (term === null || terms.has(term.toLocaleLowerCase("en-US"))) return [];
    terms.add(term.toLocaleLowerCase("en-US"));
    return [term === skill ? skill : `${skill} (as ${term})`];
  });
  if (listed.length > 0) {
    return {
      subject,
      requirementId,
      outcome: "PASS",
      reason: `Your resume lists ${listed.slice(0, 4).join(", ")}, which this requirement names.`,
      statedExcerpt: null
    };
  }
  // Non-discriminating soft requirements ("strong communication skills",
  // "experience working in a team") carry no hiring signal: nearly every
  // posting states them and no record could verify or refute them. They pass
  // by policy instead of pausing every verdict, but only when the wording
  // names no concrete tool, method, credential, quantity, or tenure span.
  // Tenure claims ("2+ years") stay paused: they are factual and checkable.
  if (isNonDiscriminatingFluff(text)) {
    return {
      subject,
      requirementId,
      outcome: "PASS",
      reason: "Non-discriminating requirement; generic traits carry no hiring signal, so this passes by policy.",
      statedExcerpt: null
    };
  }
  return {
    subject,
    requirementId,
    outcome: "UNKNOWN",
    reason: SKILL_REVIEW_REASON,
    statedExcerpt: null
  };
}

// Generic traits no record could verify or refute. Deliberately narrow: mixed
// wording with any concrete content below takes the normal evidence path.
// Stems carry \w* so plurals and verb forms ("communications",
// "collaborative", "motivated") match; "analysis" stays out because the noun
// is usually technical, while the verb ("analyze a problem") is generic.
const SOFT_FLUFF = /\b(communicat\w*|written and verbal|teamwork|team player|team|collaborat\w*|interperson\w*|analytical|analyz\w*|problem.solvin\w*|critical think\w*|attention to detail|detail.oriente\w*|fast.pace\w*|self.start\w*|self.motivat\w*|motivat\w*|proactive|eager\w*|willing\w* to learn|willingness to learn|learn quickly|quick learn\w*|fast learn\w*|growth mindset|time management|multiple projects|multitask\w*|flexib\w*|adaptab\w*|work ethic|independen\w*|organiz\w*|creativ\w*|innovat\w*|passion\w*|ownership|accountab\w*|reliab\w*|punctual|profession\w*|positive attitude|can.do|strategic think\w*|decision.mak\w*|stakeholder|leadership|peers?|colleague\w*|relationship\w*|priorit\w*|work\w* well|well with others|soft skills|people skills)\b/i;
// Concrete content that keeps a requirement on the evidence path, including
// quantities (tenure, GPA) and the verb "excel" (conservatively treated as the tool).
const CONCRETE_CONTENT = /\b(excel\b|office\b|365\b|\bword\b|powerpoint|sharepoint|tableau|power\s?bi|looker|qlik|databricks|snowflake|sql\b|mysql|postgres|mssql|nosql|sqlite|python|\bjava\b|c\+\+|javascript|typescript|\br\b|sas\b|spss|matlab|stata|figma|jira|confluence|\bgit\b|github|\baws\b|azure|gcp|kubernetes|docker|terraform|linux|salesforce|sap\b|workday|servicenow|oracle|arcgis|autocad|solidworks|mathematica|pytorch|tensorflow|machine learning|deep learning|\bllm\b|langchain|langgraph|statistical|modeling|accounting|financ|audit|cpa\b|spanish|mandarin|bilingual|french|german|degree|b\.?[as]\b|gpa|clearance|licens|certifi|\d)/i;

// Any tenure noun keeps an experience requirement paused, including spans
// without digits ("several years of experience"). Conservative by design.
const TENURE_SPAN = /\b(?:years?|yrs?|months?|mos?)\b/i;

function isNonDiscriminatingFluff(text: string): boolean {
  return SOFT_FLUFF.test(text) && !CONCRETE_CONTENT.test(text) && !TENURE_SPAN.test(text);
}

const DEGREE_SYNONYMS: Record<string, string> = {
  bs: "bachelor",
  ba: "bachelor",
  ms: "master",
  ma: "master",
  phd: "doctorate"
};

// Doctoral and professional doctorate study (a J.D. is graduate study too).
const DOCTORATE_LEVEL = /\b(?:ph\.?\s*d\b\.?|doctorate\b|doctoral\b|doctor of philosophy\b|j\.?\s*d\b\.?|juris doctor\b|law school\b)/i;
// Master's-level programs, including professional ones (MBA, MEng, MSc, MPH, MPP).
const MASTER_LEVEL = /\b(?:master'?s|master degree|master of (?:science|arts|engineering|business administration|public (?:health|policy))|m\.?\s*s\.?|m\.?\s*a\.?|m\.?\s*b\.?\s*a\.?|m\.?\s*eng|m\.?\s*sc|mph|mpp)\b/i;
// Words that make a line about the candidate's own program, not a tool name
// ("MS SQL Server") or a team member's credential.
const DEGREE_CONTEXT = /\b(?:degree|enrolled|enrollment|pursuing|program|student|candidate|studies|studying|graduate|graduating)\b/i;

/** A hard line that asks for graduate-level study, whatever subject the model labeled it with. */
const ENROLLMENT_STATEMENT = /\b(?:current(?:ly)?\s+(?:enrolled|pursuing|students?|candidates?)|enrolled\s+in|pursuing\s+(?:an?\s+)?(?:master|m\.?\s*s|ph\.?\s*d|doctor|graduate|mba|m\.?\s*b\.?\s*a))/i;
const PREFERENCE_WORDING = /\b(?:preferred|prefer|nice to have|bonus|a plus|ideally|desirable|desired)\b/i;

/**
 * A bullet the deterministic extractor left PREFERRED only because neither its
 * wording nor its heading said otherwise (confidence 0.4), which states who
 * the internship is for: "Current students pursuing a master's degree in ...".
 * Regression: Example Analytics "Quant Developer Intern" (2026-11-17)
 * listed that under "Education and Experience:" and passed the exclusion.
 */
function defaultedEnrollmentStatement(requirement: JobRequirement): boolean {
  return requirement.category === "PREFERRED" && requirement.extraction === "DETERMINISTIC" && requirement.confidence < 0.7 &&
    ENROLLMENT_STATEMENT.test(requirement.text) && !PREFERENCE_WORDING.test(requirement.text);
}

function namesGraduateStudy(requirement: Pick<JobRequirement, "text" | "subject">): boolean {
  if (!DOCTORATE_LEVEL.test(requirement.text) && !MASTER_LEVEL.test(requirement.text)) return false;
  return requirement.subject === "DEGREE" || DEGREE_CONTEXT.test(requirement.text);
}
const BACHELOR_LEVEL = /\b(?:bachelor'?s?|undergraduate|b\.?\s*s\.?|b\.?\s*a\.?)\b/i;

function hasExplicitAlternative(text: string, requiredLevel: RegExp, alternativeLevel: RegExp): boolean {
  const required = requiredLevel.exec(text);
  const alternative = alternativeLevel.exec(text);
  if (!required || !alternative) return false;
  const between = alternative.index < required.index
    ? text.slice(alternative.index + alternative[0].length, required.index)
    : text.slice(required.index + required[0].length, alternative.index);
  // B.S. / M.S. patterns may stop before their final period at a word boundary.
  const connector = between.replace(/^\.\s*/, " ");
  return !/[.;\n]/.test(connector) && /\bor\b|\//i.test(connector);
}

/**
 * Whether a posting title targets only Master's or PhD candidates; a title
 * that also names a bachelor's level ("BS/MS/PhD") does not, and a state code
 * or team code ("Boston, MA", "Mission Systems (MS)") is not a degree (Track 56).
 */
export function titleNamesGraduateStudy(title: string, context: TitleContext = {}): boolean {
  const read = withoutPlaceAndTeamCodes(title, context);
  return (DOCTORATE_LEVEL.test(read) || MASTER_LEVEL.test(read)) && !BACHELOR_LEVEL.test(read);
}

/** Whether a requirement names graduate study without accepting a bachelor's or stating a bachelor's alternative. */
export function graduateOnlyRequirement(requirement: Pick<JobRequirement, "text" | "subject">): boolean {
  return namesGraduateStudy(requirement) &&
    !acceptsBachelorLevel(requirement.text) &&
    !hasExplicitAlternative(requirement.text, DOCTORATE_LEVEL, BACHELOR_LEVEL) &&
    !hasExplicitAlternative(requirement.text, MASTER_LEVEL, BACHELOR_LEVEL);
}

function checkGraduateInternshipPreference(
  posting: JobPosting,
  preferences: CandidatePreference | null
): EligibilityFinding | null {
  if (!preferences?.excludeGraduateOnlyInternships ||
      (posting.employmentType !== "INTERNSHIP" && posting.employmentType !== "CO_OP")) return null;

  if (titleNamesGraduateStudy(posting.title, { locations: posting.locations, text: posting.snapshot.normalizedText })) {
    return {
      subject: "DEGREE",
      requirementId: null,
      outcome: "FAIL",
      reason: "The internship title targets a Master's or PhD candidate, excluded by the saved preference.",
      statedExcerpt: posting.title.slice(0, 600)
    };
  }

  const graduateOnly = posting.requirements.find((requirement) =>
    (requirement.category === "HARD" || defaultedEnrollmentStatement(requirement)) && requirement.assertion === "STATED" &&
    graduateOnlyRequirement(requirement)
  );
  return graduateOnly ? {
    subject: "DEGREE",
    requirementId: graduateOnly.id,
    outcome: "FAIL",
    reason: "The internship requires a Master's or PhD without a stated bachelor's alternative, excluded by the saved preference.",
    statedExcerpt: graduateOnly.text.slice(0, 600)
  } : null;
}

const DEGREE_STOPWORDS = new Set([
  "must", "be", "enrolled", "in", "to", "as", "at", "on", "by", "a", "an",
  "the", "or", "and", "of", "for", "program", "programs", "field", "fields",
  "related", "degree", "student", "currently", "pursuing", "seeking",
  "working", "towards", "toward"
]);

function degreeTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  const squashed = value.toLocaleLowerCase("en-US").replace(/\./g, "");
  for (const raw of squashed.split(/[^a-z]+/).filter((token) => token.length > 1)) {
    const mapped = DEGREE_SYNONYMS[raw] ?? raw;
    const variants = [mapped, mapped.endsWith("s") && mapped.length > 4 ? mapped.slice(0, -1) : mapped];
    for (const variant of variants) {
      if (variant.length > 1 && !DEGREE_STOPWORDS.has(variant)) tokens.add(variant);
    }
  }
  return tokens;
}

function checkDegree(
  requirementId: string,
  text: string,
  candidateDegree: string | null,
  context: DegreeContext
): EligibilityFinding {
  if (!candidateDegree?.trim()) {
    return {
      subject: "DEGREE",
      requirementId,
      outcome: "UNKNOWN",
      reason: "No degree is recorded on the profile, so degree eligibility needs candidate review.",
      statedExcerpt: null
    };
  }
  // A B.S. and a B.A. are different degrees; a line naming only the other kind pauses.
  const mismatch = bachelorKindMismatch(text, candidateDegree);
  if (mismatch) return { subject: "DEGREE", requirementId, outcome: "UNKNOWN", reason: mismatch, statedExcerpt: null };
  // A bachelor's candidate passes lines whose every word is understood ("BS, MS,
  // or PhD in Computer Science", "a STEM degree"); anything else falls through.
  const reading = readBachelorDegreeRequirement(text, candidateDegree, context);
  if (reading) return { subject: "DEGREE", requirementId, outcome: "PASS", reason: reading, statedExcerpt: null };
  // Say what would settle it when only the unrecorded full-time answer is missing.
  if (context.fullTimeStudent === null && readBachelorDegreeRequirement(text, candidateDegree, { ...context, fullTimeStudent: true })) {
    return {
      subject: "DEGREE",
      requirementId,
      outcome: "UNKNOWN",
      reason: "The posting asks for full-time enrollment, which is not recorded yet; answer \"Are you a full-time student?\" in candidate memory.",
      statedExcerpt: null
    };
  }
  const doctorate = DOCTORATE_LEVEL.test(text);
  const hasMatchingAlternative =
    (BACHELOR_LEVEL.test(candidateDegree) && hasExplicitAlternative(text, DOCTORATE_LEVEL, BACHELOR_LEVEL)) ||
    (MASTER_LEVEL.test(candidateDegree) && hasExplicitAlternative(text, DOCTORATE_LEVEL, MASTER_LEVEL));
  if (doctorate && !hasMatchingAlternative && !DOCTORATE_LEVEL.test(candidateDegree)) {
    return {
      subject: "DEGREE",
      requirementId,
      outcome: "UNKNOWN",
      reason: DOCTORAL_STUDY_REVIEW_REASON,
      statedExcerpt: null
    };
  }
  if (MASTER_LEVEL.test(text) && !MASTER_LEVEL.test(candidateDegree) &&
      !hasExplicitAlternative(text, MASTER_LEVEL, BACHELOR_LEVEL) &&
      !(DOCTORATE_LEVEL.test(candidateDegree) && hasExplicitAlternative(text, MASTER_LEVEL, DOCTORATE_LEVEL))) {
    return {
      subject: "DEGREE",
      requirementId,
      outcome: "UNKNOWN",
      reason: MASTER_STUDY_REVIEW_REASON,
      statedExcerpt: null
    };
  }
  const required = degreeTokens(text);
  const held = degreeTokens(candidateDegree);
  const shared = [...required].filter((token) => held.has(token));
  if (shared.length >= 2) {
    return {
      subject: "DEGREE",
      requirementId,
      outcome: "PASS",
      reason: `The profile degree shares ${shared.slice(0, 4).join(", ")} with the stated requirement.`,
      statedExcerpt: null
    };
  }
  // Degree wording varies too much to fail deterministically; a weak overlap
  // pauses instead.
  return {
    subject: "DEGREE",
    requirementId,
    outcome: "UNKNOWN",
    reason: DEGREE_WORDING_REVIEW_REASON,
    statedExcerpt: null
  };
}

function inWindow(value: string, earliest: string | null, latest: string | null): boolean {
  if (earliest && value < earliest) return false;
  if (latest && value > latest) return false;
  return true;
}
