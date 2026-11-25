import { isHearAboutQuestion } from "@internship-agent/browser";
import { mentionsCompany, mentionsSiteTenant, normalizeCompanyName, type CandidateFactKey, type FactScope, type QuestionContext, type QuestionMapping } from "@internship-agent/domain";
import { readPlace } from "@internship-agent/jobs";

import { mapStandardQuestion } from "./standard-question-mapper";

export interface SemanticQuestionMapper {
  map(question: string, context?: QuestionContext): Promise<QuestionMapping>;
}

const protectedPattern = /\b(race|ethnicity|ethnic|gender|sex|sexual orientation|transgender|disability|disabled|veteran|religion|marital status)\b/i;
const attestationPattern = /\b(certify|attest|under penalty|declare that|signature confirms|information (?:is|provided is) true)\b/i;
const END_DATE = /\blatest\s+(?:possible\s+)?(?:end|finish|available)\b|\bavailable\s+until\b|\bavailability\s+end\b|\blast\s+day\s+of\s+(?:availability|the internship)\b|\b(?:end|finish)\s+date\b.{0,40}\b(?:internship|availability|available)\b|\b(?:internship|availability|available)\b.{0,40}\b(?:end|finish)\s+date\b|\bwhen\s+(?:can|could|would)\s+you\s+(?:end|finish)\b/i;
const PREVIOUS_EMPLOYMENT = /\b(?:(?:have|had)\s+you\s+(?:ever\s+)?(?:previously\s+|formerly\s+)?(?:been\s+)?(?:work(?:ed)?|employed|intern(?:ed)?)|(?:previously|formerly|ever|before)\s+(?:been\s+)?(?:work(?:ed)?|employed|intern(?:ed)?)|(?:current\s+or\s+)?former\s+(?:employee|intern|worker|contractor)|previous(?:ly)?\s+(?:employee|worker|intern)|did\s+you\s+(?:ever\s+|previously\s+)?(?:work(?:ed)?|intern(?:ed)?))\b/i;
const COURSEWORK = /\b(?:relevant|related|completed|applicable)\s+(?:course\s*work|courses|classes)\b|\bcourse\s*work\b|\b(?:courses|classes)\s+(?:that\s+)?(?:you(?:'ve|\s+have)?\s+)?(?:taken|completed)\b|\b(?:which|what|list(?:\s+any)?)\s+(?:relevant\s+)?(?:courses|classes)\b/i;
// Grades, GPA, transcripts, credit counts, and non-academic courses are never answered with the course list.
const NOT_COURSEWORK = /\b(?:gpa|grade|grades|graded|grading|grade\s+point|marks?|scores?|transcripts?|credits?|units|honou?rs|online|certifications?|certificates?|bootcamps?|training)\b/i;
const ELIGIBLE_TO_WORK = /\b(?:legally )?eligible to work\b|\blegally (?:able|permitted) to work\b/i;
// "Eligible to work" also opens government, export-control, and clearance questions, which only their own saved answers decide.
const NOT_WORK_AUTHORIZATION = /\b(?:government|federal|public sector|dod|department of defense|defen[cs]e|export\w*|itar|ear|citizen\w*|u\.?\s?s\.? (?:person|national)|clearances?|security|contracts?|contractors?|projects?)\b/i;
// Relocation the candidate pays for is its own answer (willing_to_relocate_at_own_expense).
const OWN_EXPENSE = /\b(?:at )?(?:my|your) own (?:expense|cost)\b|\bown expense\b|\bwithout (?:relocation )?(?:assistance|support|reimbursement)\b|\bself[- ]funded\b/i;
// Willingness to undergo a background check: never a criminal-history answer or a consent or authorization.
const BACKGROUND_CHECK = /\bbackground (?:check|screening|investigation)s?\b/i;
const WILLING_TO_UNDERGO = /\b(?:willing|prepared|open)\b[^?]{0,40}\b(?:undergo|submit to|complete|go through|participate in|take)\b|\bwould you (?:undergo|submit to|complete)\b/i;
const NOT_WILLINGNESS = /\bpass\w*|\bclear(?:ed)?\b|\bconvict\w*|\barrest\w*|\bfelon\w*|\bdrug\w*|\bcredit\b|\bfingerprint\w*|\bclearances?\b|\bresults?\b|\bconsent\w*|\bauthori[sz]\w*|\bagree\w*|\bpermit\b|\ballow\w*|\bdisclos\w*|\bexplain\b|\bdescribe\b/i;
const EMPLOYER_REFERENCE = /\b(?:here|for us|with us|(?:this|our|the)\s+(?:company|organization|organisation|firm|employer))\b/i;

export class DeterministicQuestionMapper implements SemanticQuestionMapper {
  async map(question: string, context: QuestionContext = {}): Promise<QuestionMapping> {
    const trimmed = question.trim();
    const normalized = trimmed.toLocaleLowerCase("en-US").replace(/\s+/g, " ");

    if (protectedPattern.test(normalized)) {
      return {
        status: "BLOCKED",
        policy: "protected",
        reason: "Protected demographic questions are never answered from remembered answers; saved voluntary self-identification answers fill only matching options in EEO questions during browser runs."
      };
    }
    if (attestationPattern.test(normalized)) {
      return {
        status: "BLOCKED",
        policy: "attestation",
        reason: "Application-specific attestations must be reviewed and answered directly each time."
      };
    }

    if (isHearAboutQuestion(trimmed)) {
      return {
        status: "MAPPED",
        key: "how_heard",
        scope: { kind: "global" },
        confidence: 0.95,
        method: "deterministic",
        explanation: "How-did-you-hear question."
      };
    }

    // Relocation is recorded per country: a named place readable as a country,
    // else the question's own country words, else the posting's one country.
    if (/\b(relocat(?:e|ion|ing)|move)\b/i.test(normalized)) {
      const ownExpense = OWN_EXPENSE.test(normalized);
      const relocationKey: CandidateFactKey = ownExpense ? "willing_to_relocate_at_own_expense" : "willing_to_relocate";
      const suffix = ownExpense ? " (at own expense)" : "";
      const named = context.location ?? extractRelocationLocation(trimmed);
      if (named) {
        const country = countryOfPlace(named);
        if (country) {
          return {
            status: "MAPPED",
            key: relocationKey,
            scope: { kind: "country", code: country },
            confidence: 0.96,
            method: "deterministic",
            explanation: `Relocation question naming ${named}, a place in ${country}${suffix}.`
          };
        }
        return {
          status: "MAPPED",
          key: relocationKey,
          scope: { kind: "location", name: named },
          confidence: 0.98,
          method: "deterministic",
          explanation: `Relocation question scoped to ${named}${suffix}.`
        };
      }
      const country = relocationCountry(trimmed, context);
      if (!country) {
        return { status: "AMBIGUOUS", reason: "Relocation willingness is recorded per country, and neither the question nor the posting names one." };
      }
      return {
        status: "MAPPED",
        key: relocationKey,
        scope: { kind: "country", code: country },
        confidence: 0.95,
        method: "deterministic",
        explanation: `General relocation question for ${country}${suffix}.`
      };
    }

    if (/\b(?:legally )?authori[sz]ed to work\b|\bwork authori[sz]ation\b/i.test(normalized) || (ELIGIBLE_TO_WORK.test(normalized) && !NOT_WORK_AUTHORIZATION.test(normalized))) {
      const country = inferCountryCode(normalized, context);
      if (!country) {
        return { status: "AMBIGUOUS", reason: "Work authorization requires an explicit country scope, and neither the question nor the posting names one country." };
      }
      return {
        status: "MAPPED",
        key: "authorized_to_work",
        scope: { kind: "country", code: country.code },
        confidence: 0.99,
        method: "deterministic",
        explanation: `Work-authorization question scoped to ${country.code}${country.fromPosting ? " (the posting's country)" : ""}.`
      };
    }

    if (/\b(?:require|need).{0,30}(?:sponsor|sponsorship)\b|\bvisa sponsorship\b/i.test(normalized)) {
      const country = inferCountryCode(normalized, context);
      if (!country) {
        return { status: "AMBIGUOUS", reason: "Sponsorship requirements require an explicit country scope, and neither the question nor the posting names one country." };
      }
      return {
        status: "MAPPED",
        key: "requires_sponsorship",
        scope: { kind: "country", code: country.code },
        confidence: 0.98,
        method: "deterministic",
        explanation: `Employment-sponsorship question scoped to ${country.code}${country.fromPosting ? " (the posting's country)" : ""}.`
      };
    }

    // Before the start date: "latest end date" asks when the internship can end.
    if (END_DATE.test(normalized) && !/\b(?:year|month|day)\b/i.test(normalized.replace(/\blast day of\b/, ""))) {
      if (/\b(?:start|begin)\b/i.test(normalized)) {
        return { status: "AMBIGUOUS", reason: "The question asks for both a start and an end date; answer it directly." };
      }
      return {
        status: "MAPPED",
        key: "available_end_date",
        scope: { kind: "global" },
        confidence: 0.94,
        method: "deterministic",
        explanation: "Latest internship end-date question."
      };
    }

    // A single year/month/day box ("Start date year") belongs to a date on
    // the form itself, such as education history, not to internship availability.
    if (/\b(?:available|availability).{0,24}(?:start|begin)|\bstart date\b/i.test(normalized) &&
      !/\b(?:year|month|day)\b/i.test(normalized)) {
      return {
        status: "MAPPED",
        key: "available_start_date",
        scope: { kind: "global" },
        confidence: 0.96,
        method: "deterministic",
        explanation: "Candidate availability-date question."
      };
    }

    // Before graduation: "Are you a full-time student graduating in 2028?" asks about enrollment.
    if (/\bfull[- ]?time\b.{0,30}\b(?:student|enrolled|enrollment|undergraduate)\b|\b(?:student|enrolled|enrollment)\b.{0,30}\bfull[- ]?time\b/i.test(normalized)) {
      return {
        status: "MAPPED",
        key: "enrolled_full_time",
        scope: { kind: "global" },
        confidence: 0.95,
        method: "deterministic",
        explanation: "Full-time student enrollment question."
      };
    }

    if (/\b(?:graduate|graduation|degree completion).{0,24}(?:date|when|expected)|\bexpected graduation\b/i.test(normalized)) {
      // A channel-specific application asks for the channel's answer; the
      // resolver falls back to the global answer only inside that channel.
      return {
        status: "MAPPED",
        key: "graduation_date",
        scope: context.applicationChannel
          ? { kind: "application_channel", channel: context.applicationChannel }
          : { kind: "global" },
        confidence: 0.96,
        method: "deterministic",
        explanation: context.applicationChannel
          ? "Candidate graduation-date question on a Handshake Quick Apply / Apply application."
          : "Candidate graduation-date question."
      };
    }

    // Previous employment only for this employer: "here", "this company", the
    // posting's company by name, or the employer that runs the Workday site
    // (its tenant, e.g. Highmark Health for an enGen posting on
    // highmarkhealth.wd1). Another company's name stays unmapped.
    if (PREVIOUS_EMPLOYMENT.test(normalized) &&
      (EMPLOYER_REFERENCE.test(normalized) ||
        (context.companyName && mentionsCompany(trimmed, context.companyName)) ||
        (context.employerSite && mentionsSiteTenant(trimmed, context.employerSite)))) {
      return {
        status: "MAPPED",
        key: "previously_worked_here",
        scope: companyScope(context),
        confidence: 0.95,
        method: "deterministic",
        explanation: "Previous employment or internship at this company."
      };
    }

    if (/\b(?:relatives?|family\s+members?|immediate\s+family|related\s+to)\b/i.test(normalized) &&
      (/\b(?:work(?:s|ing)?|employ(?:ed|ee|ees)|director|officer|board)\b/i.test(normalized) ||
        EMPLOYER_REFERENCE.test(normalized) ||
        Boolean(context.companyName && mentionsCompany(trimmed, context.companyName))) &&
      !/\b(?:competitor|government|public\s+official|official|politic\w*)\b/i.test(normalized) &&
      // Family who buy from, sell to, or practice health care with the company is a different question.
      !/\b(?:products?|purchas\w*|customers?|clients?|vendors?|suppliers?|health\s*care|practic\w*)\b/i.test(normalized)) {
      return {
        status: "MAPPED",
        key: "relatives_at_company",
        scope: companyScope(context),
        confidence: 0.93,
        method: "deterministic",
        explanation: "Relatives working at this company."
      };
    }

    if (BACKGROUND_CHECK.test(normalized) && WILLING_TO_UNDERGO.test(normalized) && !NOT_WILLINGNESS.test(normalized)) {
      return {
        status: "MAPPED",
        key: "willing_background_check",
        scope: { kind: "global" },
        confidence: 0.94,
        method: "deterministic",
        explanation: "Willingness to undergo a background check (not criminal history, not an authorization)."
      };
    }

    const standard = mapStandardQuestion(trimmed, context);
    if (standard) return standard;

    if (/\b(?:at\s+least|over|older\s+than|above)\s+(?:the\s+age\s+of\s+)?(?:18|eighteen)\b|\b(?:18|eighteen)\s*(?:\+|years?(?:\s+of\s+age|\s+old)?\s+or\s+older|or\s+older)|\blegal(?:\s+working)?\s+age\b/i.test(normalized) &&
      !/\b(?:under|younger|below|less\s+than|not\s+yet)\b/i.test(normalized)) {
      return {
        status: "MAPPED",
        key: "age_18_or_older",
        scope: { kind: "global" },
        confidence: 0.96,
        method: "deterministic",
        explanation: "Age 18 or older question."
      };
    }

    if (/\bpronouns?\b/i.test(normalized)) {
      return {
        status: "MAPPED",
        key: "pronouns",
        scope: { kind: "global" },
        confidence: 0.97,
        method: "deterministic",
        explanation: "Pronouns question."
      };
    }

    if (/\b(?:on[- ]?site|in[- ]office|in[- ]person|in\s+the\s+office|in\s+(?:the|our)\s+(?:[a-z][\w.'-]*\s+){0,3}office|hybrid)\b/i.test(normalized) &&
      /\b(?:open|willing|able|comfortable|ok(?:ay)?|agree|available)\b|\bcan\s+you\b|\bwould\s+you\b/i.test(normalized) &&
      !/\b(?:prefer\w*|unable|not\s+able|cannot|can't|remote\s+only|fully\s+remote)\b/i.test(normalized) &&
      // Whether the candidate can work "from this location" depends on where they live or would
      // relocate, which the on-site answer does not say; it pauses.
      !/\bthis\s+location\b/i.test(normalized)) {
      return {
        status: "MAPPED",
        key: "work_arrangement",
        scope: { kind: "global" },
        confidence: 0.92,
        method: "deterministic",
        explanation: "Open to on-site or hybrid work question."
      };
    }

    if (COURSEWORK.test(normalized) && !NOT_COURSEWORK.test(normalized)) {
      return {
        status: "MAPPED",
        key: "relevant_coursework",
        scope: { kind: "global" },
        confidence: 0.93,
        method: "deterministic",
        explanation: "Relevant coursework question; answered from the candidate's saved courses."
      };
    }

    return {
      status: "UNMAPPED",
      reason: "The question does not match a reviewed fact definition."
    };
  }
}

/** The posting's employer as a company scope; global when no usable company name is known. */
function companyScope(context: QuestionContext): FactScope {
  const name = context.companyName ? normalizeCompanyName(context.companyName) : "";
  return name.length >= 1 && name.length <= 120 ? { kind: "company", name } : { kind: "global" };
}

/** "Austin, TX" is US; "London, UK" is GB; a bare city ("Seattle") names no country. */
function countryOfPlace(place: string): string | null {
  const codes = new Set<string>();
  for (const piece of place.split(/,|\s+-\s+/)) {
    const reading = readPlace(piece);
    if (reading?.kind === "us-state") codes.add("US");
    else if (reading?.kind === "ca-province") codes.add("CA");
    else if (reading?.kind === "country") codes.add(reading.code);
  }
  return codes.size === 1 ? [...codes][0]! : null;
}

/** A pause answer's country, then the question's own country words, then the posting's one stated country. */
function relocationCountry(question: string, context: QuestionContext): string | null {
  if (context.countryCode) return context.countryCode.toUpperCase();
  if (/\b(?:united states|usa)\b|\bu\.s\.(?:a\.)?/i.test(question) || /\bUS\b/.test(question)) return "US";
  if (/\bcanada\b/i.test(question)) return "CA";
  return context.postingCountryCode?.toUpperCase() ?? null;
}

/**
 * The country an authorization or sponsorship question is about: a pause
 * answer's country, then the question's own country words, then the posting's
 * one stated country (postingQuestionContext sets it only when the posting
 * states exactly one). Null when none of them names one.
 */
function inferCountryCode(question: string, context: QuestionContext): { code: string; fromPosting: boolean } | null {
  if (context.countryCode) return { code: context.countryCode.toUpperCase(), fromPosting: false };
  if (/\b(?:united states|u\.?s\.?(?:a\.)?)\b/i.test(question)) return { code: "US", fromPosting: false };
  if (/\bcanada\b/i.test(question)) return { code: "CA", fromPosting: false };
  const posting = context.postingCountryCode?.toUpperCase();
  return posting ? { code: posting, fromPosting: true } : null;
}

function extractRelocationLocation(question: string): string | null {
  const match = question.match(/(?:relocat(?:e|ing)|move)\s+to\s+(.+?)(?:\s+for\s+(?:this|the)\s+(?:role|job|position)|[?.!]|$)/i);
  if (!match?.[1]) return null;
  const location = match[1].trim().replace(/,$/, "");
  return location.length >= 2 && location.length <= 120 ? location : null;
}
