import type {
  BrowserField,
  FillDecision,
  PauseRecord,
  RecognizedForm
} from "@internship-agent/domain";
import { bachelorKind, campusOption, checkboxAnswer, chooseDegreeOption, isStandardAnswerKey, matchOfferedOption, promptSearchTerms, sameNameKey, sameNamedOption, standardAnswerOption } from "@internship-agent/domain";

import { classifyFieldRole, classifyUploadRole, isSensitiveRole } from "./ats/field-roles";
import { isHearAboutQuestion, pickHearAboutOption } from "./ats/hear-about";
import { usStateAlternate } from "./ats/us-states";
import { isSafeguardField, stripRequiredMarker } from "./form-recognition";
import { standingFieldDecision, type StandingInputs } from "./standing-fields";

export type FieldResolution =
  | { status: "RESOLVED"; key: string; scope: string; display: string; value: boolean | string }
  | { status: "NEEDS_INPUT"; key: string | null; scope: string | null }
  | { status: "UNAVAILABLE" }
  /** A saved voluntary self-identification answer matched exactly one offered option (ats/self-identification.ts). */
  | { status: "SELF_IDENTIFIED"; key: string; option: string }
  /** A candidate-supplied answer from question memory, read only for questions the catalog does not map. */
  | { status: "REMEMBERED_ANSWER"; answerId: string; answer: string; answerKey: string; answerKind: "text" | "option" };

/** Contact details the candidate entered on the profile page. */
export type ContactProfile = {
  /** The name on the profile, for a single "Name" / "Full name" box. */
  fullName?: string;
  /** The preferred name the candidate entered; never derived from the legal name. */
  preferredName?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  legalFirstName?: string;
  legalLastName?: string;
  addressLine1?: string;
  addressLine2?: string;
  addressCity?: string;
  addressRegion?: string;
  addressPostalCode?: string;
  addressCountry?: string;
  phoneType?: string;
  fieldOfStudy?: string;
  /** The GPA on the profile ("3.691"); filled only into whole-label GPA fields (gpaDecision). */
  gpa?: string;
};

export type PlannerInputs = {
  profile: { email?: string; phone?: string; portfolioUrl?: string } & ContactProfile;
  /** Memory resolution per field id, computed by the orchestrator. */
  resolutions: Map<string, FieldResolution>;
  packageAnswers: Array<{ prompt: string; text: string }>;
  variantId: string | null;
  /** The candidate's stored transcript, uploaded only into transcript fields. */
  transcriptDocumentId?: string | null;
  /** The profile's education, for an education block (School, Degree, start and end month and year). */
  education?: EducationInputs;
  /** The candidate's standing consent and attestation settings; absent, consent boxes pause and signatures wait. */
  standing?: StandingInputs;
};

export type EducationInputs = {
  school?: string;
  degree?: string;
  /** YYYY-MM, from the profile. */
  startMonth?: string;
  /** The run profile's graduation date (YYYY-MM-DD) and where it came from; absent when that profile has none. */
  graduation?: { date: string; basis: NonNullable<FillDecision["basis"]> };
};

export type AutofillPlan = {
  decisions: FillDecision[];
  pauses: PauseRecord[];
  safeguardHalt: boolean;
};

/**
 * Deterministic autofill planning. Known answers (facts, profile contact,
 * prepared package answers) become fill decisions with their basis recorded;
 * everything else pauses for the candidate or skips when optional. The
 * planner never invents a value and never routes around a safeguard.
 */
export function planAutofill(form: RecognizedForm, inputs: PlannerInputs): AutofillPlan {
  const decisions: FillDecision[] = [];
  const pauses: PauseRecord[] = [];
  let safeguardHalt = false;

  for (const field of form.fields) {
    if (isSafeguardField(field)) {
      safeguardHalt = true;
      decisions.push(pauseDecision(field, {
        question: `This application shows a safeguard challenge ("${field.label}"). The run is halted rather than worked around.`,
        key: null,
        scope: null,
        safeguard: true
      }));
      pauses.push(pauseRecord(field, decisions[decisions.length - 1], false));
      continue;
    }
    const role = classifyFieldRole(field);
    // Consent, attestation, and signature fields under the candidate's standing
    // settings (standing-fields.ts). A sensitive list or radio set never reaches
    // them; a single checkbox (an EEO acknowledgment) may.
    if (!isSensitiveRole(role) || field.kind === "checkbox") {
      const standing = standingFieldDecision(field, form, inputs.standing);
      if (standing) {
        decisions.push(standing);
        if (standing.action === "pause" && standing.pause) pauses.push(pauseRecord(field, standing, false));
        continue;
      }
    }
    if (isSensitiveRole(role)) {
      // Demographic and equal-opportunity questions are filled only from the
      // candidate's saved voluntary self-identification answers, and only when
      // exactly one offered option matches; otherwise the candidate answers
      // in-session and nothing is stored.
      const saved = inputs.resolutions.get(field.id);
      if (saved?.status === "SELF_IDENTIFIED" && (field.kind === "select" || field.kind === "radio") && field.options?.includes(saved.option)) {
        decisions.push({
          fieldId: field.id,
          action: "choose",
          value: saved.option,
          basis: { kind: "fact", key: saved.key, scope: "global" },
          reason: "Your saved voluntary self-identification answer matches one of the offered options.",
          pause: null
        });
        continue;
      }
      decisions.push(pauseDecision(field, {
        question: `This looks like a demographic or equal-opportunity question ("${field.label}"). Please answer it yourself; it will not be stored.`,
        key: null,
        scope: null,
        safeguard: false
      }));
      pauses.push(pauseRecord(field, decisions[decisions.length - 1], true));
      continue;
    }
    if (field.kind === "checkbox" && (field.options?.length ?? 0) < 2 && isConsentCheckbox(field.label)) {
      // Consent to keep or process the candidate's data is theirs to give, per application: never ticked automatically.
      decisions.push(pauseDecision(field, { question: CONSENT_QUESTION, key: null, scope: null, safeguard: false }));
      pauses.push(pauseRecord(field, decisions[decisions.length - 1]!, false));
      continue;
    }
    const decision = decideField(field, inputs);
    decisions.push(decision);
    if (decision.action === "pause" && decision.pause) {
      pauses.push(pauseRecord(field, decision, false));
    }
  }
  return { decisions, pauses, safeguardHalt };
}

function decideField(field: BrowserField, inputs: PlannerInputs): FillDecision {
  const resolution = inputs.resolutions.get(field.id);

  if (isHearAboutQuestion(field.label)) {
    const saved = resolution?.status === "RESOLVED" && resolution.key === "how_heard" ? resolution : null;
    // A list, radio set, or checkbox group (Greenhouse's "LinkedIn / Glassdoor / Indeed / …" boxes) is one question.
    if ((field.kind === "select" || field.kind === "radio" || field.kind === "checkbox") && field.options?.length) {
      const option = pickHearAboutOption(field.options, `${field.id}|${field.options.join("|")}`, saved?.display ?? null);
      if (option) {
        return {
          fieldId: field.id,
          action: "choose",
          value: option,
          basis: saved ? { kind: "fact", key: saved.key, scope: saved.scope } : null,
          reason: "Your rule for “How did you hear about us?”: your saved answer, else a job board, else LinkedIn, else another board, N/A, or any non-referral option.",
          pause: null
        };
      }
    } else if (field.currentValue && !field.options?.length) {
      // A Workday prompt that already shows a pick is read without its options: keep it.
      return { fieldId: field.id, action: "keep", value: field.currentValue, basis: null, reason: "The site already shows this value.", pause: null };
    }
  }

  const contact = contactValue(field.label, inputs.profile);
  if (contact && (TEXT_KINDS.has(field.kind) || field.kind === "select" || field.kind === "radio")) {
    if (field.widget === "autocomplete") {
      // A Country type-ahead searches by the country's name: a "US" / "USA" profile value types "United States".
      const typed = contact.key === "addressCountry" && US_COUNTRY_KEYS.has(countryKey(contact.value)) ? "United States" : contact.value;
      return suggest(field, typed, { kind: "profile", field: contact.key });
    }
    if (TEXT_KINDS.has(field.kind)) return fill(field, contact.value, { kind: "profile", field: contact.key }, "Contact details from your profile.");
    const match = field.options?.find((option) => option.toLocaleLowerCase("en-US") === contact.value.toLocaleLowerCase("en-US"))
      ?? dialCodeOption(contact.value, field.options ?? [])
      ?? (contact.key === "addressCountry" ? matchCountryOption(contact.value, field.options ?? []) ?? undefined : undefined)
      ?? (contact.key === "addressRegion" ? stateOption(contact.value, field.options ?? []) : undefined);
    if (match) {
      return { fieldId: field.id, action: "choose", value: match, basis: { kind: "profile", field: contact.key }, reason: "Contact details from your profile.", pause: null };
    }
    return pauseDecision(field, {
      question: `Your profile says "${contact.value}" for "${field.label}", which is not one of its options. Which option should be chosen?`,
      key: null,
      scope: null,
      safeguard: false
    });
  }

  const education = educationDecision(field, inputs.education);
  if (education) return education;
  const gpa = gpaDecision(field, inputs.profile.gpa);
  if (gpa) return gpa;

  if (field.kind === "email") {
    if (inputs.profile.email) {
      return fill(field, inputs.profile.email, { kind: "profile", field: "email" }, "Profile email address.");
    }
    return pauseDecision(field, {
      question: `What email address should be used for "${field.label}"?`,
      key: null,
      scope: null,
      safeguard: false
    });
  }
  if (field.kind === "tel") {
    if (inputs.profile.phone) {
      return fill(field, inputs.profile.phone, { kind: "profile", field: "phone" }, "Profile phone number.");
    }
    return pauseDecision(field, {
      question: `What phone number should be used for "${field.label}"?`,
      key: null,
      scope: null,
      safeguard: false
    });
  }
  if (field.widget === "autocomplete" && field.kind !== "select") {
    // A type-ahead takes only a known value typed in and a matching suggestion picked.
    if (resolution?.status === "RESOLVED" && typeof resolution.value === "string") {
      return suggest(field, resolution.display, { kind: "fact", key: resolution.key, scope: resolution.scope });
    }
    if (resolution?.status === "REMEMBERED_ANSWER") return rememberedSuggestion(field, resolution);
    if (!field.required) return skip(field, "Optional field with no known answer stays empty.");
    return pauseDecision(field, {
      question: `How should "${field.label}" be answered?`,
      key: resolution?.status === "NEEDS_INPUT" ? resolution.key : null,
      scope: resolution?.status === "NEEDS_INPUT" ? resolution.scope : null,
      safeguard: false
    });
  }
  if (field.kind === "file") {
    const role = classifyUploadRole(field.label, field.id);
    if (role === "resume") {
      if (inputs.variantId) {
        return {
          fieldId: field.id,
          action: "upload",
          value: null,
          basis: { kind: "variant", variantId: inputs.variantId },
          reason: "Uploads the prepared resume variant.",
          pause: null
        };
      }
      return pauseDecision(field, {
        question: `"${field.label}" asks for your resume. Upload it on the profile page, then start the run again.`,
        key: null,
        scope: null,
        safeguard: false
      });
    }
    if (role === "transcript" && inputs.transcriptDocumentId) {
      return {
        fieldId: field.id,
        action: "upload",
        value: null,
        basis: { kind: "candidate_document", documentId: inputs.transcriptDocumentId },
        reason: "Uploads your transcript (PDF, checksum-verified).",
        pause: null
      };
    }
    // An optional cover letter or other document stays empty; only a required one waits for the candidate.
    // A resume is NEVER skipped, whether marked required or optional (handled above).
    if (!field.required && role !== "transcript") {
      return skip(field, "Optional upload left empty; the agent attaches only your resume and transcript.");
    }
    return pauseDecision(field, {
      question: role === "transcript"
        ? `"${field.label}" asks for your transcript. Upload it on the profile page, then start the run again.`
        : `"${field.label}" asks for a document the agent does not upload. Attach it yourself in the application.`,
      key: null,
      scope: null,
      safeguard: false
    });
  }
  if (field.kind === "checkbox" && (field.options?.length ?? 0) >= 2) {
    // A checkbox group is one question answered with one option; it is never "checked" as a whole.
    if (resolution?.status === "RESOLVED") {
      const wanted = resolution.display.toLocaleLowerCase("en-US");
      const matches = field.options!.filter((option) => option.toLocaleLowerCase("en-US") === wanted);
      if (matches.length === 1) {
        return {
          fieldId: field.id,
          action: "choose",
          value: matches[0]!,
          basis: { kind: "fact", key: resolution.key, scope: resolution.scope },
          reason: "A remembered fact matches one of the offered options.",
          pause: null
        };
      }
    }
    if (resolution?.status === "REMEMBERED_ANSWER") {
      const option = matchOfferedOption(field.options!, resolution.answer);
      if (option) {
        return {
          fieldId: field.id,
          action: "choose",
          value: option,
          basis: { kind: "question_answer", answerId: resolution.answerId },
          reason: "Your saved answer to this question matches one of the offered options.",
          pause: null
        };
      }
      // The pause never echoes the saved answer.
      return pauseDecision(field, {
        question: `Your saved answer to "${field.label}" is not one of its options. How should it be answered?`.slice(0, 500),
        key: null,
        scope: null,
        safeguard: false
      });
    }
    if (field.currentValue) {
      return { fieldId: field.id, action: "keep", value: field.currentValue, basis: null, reason: "The site already shows this value.", pause: null };
    }
    if (!field.required) return skip(field, "Optional choice with no known answer stays untouched.");
    return pauseDecision(field, {
      question: `How should "${field.label}" be answered?`,
      key: resolution?.status === "NEEDS_INPUT" ? resolution.key : null,
      scope: resolution?.status === "NEEDS_INPUT" ? resolution.scope : null,
      safeguard: false
    });
  }
  if (field.kind === "checkbox") {
    if (resolution?.status === "REMEMBERED_ANSWER" && !field.options?.length) {
      const box = checkboxAnswer(resolution.answer);
      if (box === "Yes") {
        return {
          fieldId: field.id,
          action: "check",
          value: "true",
          basis: { kind: "question_answer", answerId: resolution.answerId },
          reason: "Your saved answer to this question checks this box.",
          pause: null
        };
      }
      if (box === "No") return skip(field, "Your saved answer to this question leaves this box unchecked.");
    }
    if (resolution?.status === "RESOLVED" && resolution.value === true) {
      return {
        fieldId: field.id,
        action: "check",
        value: "true",
        basis: { kind: "fact", key: resolution.key, scope: resolution.scope },
        reason: "A remembered fact affirms this checkbox.",
        pause: null
      };
    }
    if (resolution?.status === "NEEDS_INPUT") {
      return pauseDecision(field, {
        question: `How should "${field.label}" be answered?`,
        key: resolution.key,
        scope: resolution.scope,
        safeguard: false
      });
    }
    if (!field.required) {
      return skip(field, "Optional checkbox with no known answer stays untouched.");
    }
    return pauseDecision(field, {
      question: `How should "${field.label}" be answered?`,
      key: null,
      scope: null,
      safeguard: false
    });
  }

  if (resolution?.status === "RESOLVED") {
    if (field.widget === "autocomplete" && field.kind === "select") {
      return suggest(field, resolution.display, { kind: "fact", key: resolution.key, scope: resolution.scope });
    }
    if ((field.kind === "select" || field.kind === "radio") && field.options) {
      const match = field.options.find((option) =>
        option.toLocaleLowerCase("en-US") === resolution.display.toLocaleLowerCase("en-US")
      ) ?? (resolution.key === "pronouns" ? matchPronounOption(resolution.display, field.options) : undefined)
        ?? (standardAnswerOption(resolution.key, resolution.value, field.options) ?? undefined);
      if (!match && isStandardAnswerKey(resolution.key)) {
        // A legal or background answer is never echoed in the pause.
        return pauseDecision(field, {
          question: `The saved answer is not among the options for "${field.label}". How should it be answered?`,
          key: resolution.key,
          scope: resolution.scope,
          safeguard: false
        });
      }
      if (!match) {
        return pauseDecision(field, {
          question: `The remembered answer is "${resolution.display}", which is not among the options for "${field.label}". How should it be answered?`,
          key: resolution.key,
          scope: resolution.scope,
          safeguard: false
        });
      }
      return {
        fieldId: field.id,
        action: "choose",
        value: match,
        basis: { kind: "fact", key: resolution.key, scope: resolution.scope },
        reason: "A remembered fact matches one of the offered options.",
        pause: null
      };
    }
    return fill(field, resolution.display, { kind: "fact", key: resolution.key, scope: resolution.scope }, "A remembered fact answers this field.");
  }
  if (resolution?.status === "NEEDS_INPUT") {
    return pauseDecision(field, {
      question: `How should "${field.label}" be answered?`,
      key: resolution.key,
      scope: resolution.scope,
      safeguard: false
    });
  }
  if (resolution?.status === "REMEMBERED_ANSWER") {
    const reused = rememberedAnswerDecision(field, resolution);
    if (reused) return reused;
  }

  const packaged = matchPackageAnswer(field, inputs.packageAnswers);
  if (packaged) {
    return fill(field, packaged.text, { kind: "package-answer", prompt: packaged.prompt }, "The verified application package answers this field.");
  }
  if (field.currentValue) {
    // Nothing known says otherwise: leave what the site shows (a default or a
    // saved draft) exactly as it is; the candidate sees it at review.
    return { fieldId: field.id, action: "keep", value: field.currentValue, basis: null, reason: "The site already shows this value.", pause: null };
  }
  if (!field.required) {
    return skip(field, "Optional field with no known answer stays empty.");
  }
  return pauseDecision(field, {
    question: `How should "${field.label}" be answered?`,
    key: null,
    scope: null,
    safeguard: false
  });
}

/** A saved question-memory answer: an exactly matching option, or verbatim text; never a guess. */
function rememberedAnswerDecision(
  field: BrowserField,
  resolution: Extract<FieldResolution, { status: "REMEMBERED_ANSWER" }>
): FillDecision | null {
  const basis = { kind: "question_answer" as const, answerId: resolution.answerId };
  // A type-ahead (also a react-select list, whose answer is stored as an option) takes the saved answer typed into its suggestions.
  if (field.widget === "autocomplete") return rememberedSuggestion(field, resolution);
  if (field.kind === "select" || field.kind === "radio") {
    if (!field.options?.length) return null;
    const option = matchOfferedOption(field.options, resolution.answer);
    if (option) {
      return {
        fieldId: field.id,
        action: "choose",
        value: option,
        basis,
        reason: "Your saved answer to this question matches one of the offered options.",
        pause: null
      };
    }
    // The pause never echoes the saved answer.
    return pauseDecision(field, {
      question: `Your saved answer to "${field.label}" is not one of its options. How should it be answered?`.slice(0, 500),
      key: null,
      scope: null,
      safeguard: false
    });
  }
  if (resolution.answerKind === "text" && ["text", "textarea", "number", "url", "date"].includes(field.kind)) {
    return fill(field, resolution.answer, basis, "Your saved answer to this question.");
  }
  return null;
}

/** A saved question-memory answer typed into a type-ahead; the executor picks the matching suggestion (matchSuggestion). */
function rememberedSuggestion(
  field: BrowserField,
  resolution: Extract<FieldResolution, { status: "REMEMBERED_ANSWER" }>
): FillDecision {
  return {
    fieldId: field.id,
    action: "choose",
    value: resolution.answer,
    basis: { kind: "question_answer", answerId: resolution.answerId },
    reason: "Your saved answer, typed into the site's suggestion list.",
    pause: null
  };
}

function matchPackageAnswer(
  field: BrowserField,
  answers: PlannerInputs["packageAnswers"]
): PlannerInputs["packageAnswers"][number] | null {
  const label = field.label.toLocaleLowerCase("en-US");
  const wantsInterest = /why|interest|motivat|company/.test(label);
  const wantsExperience = /experience|background|relevant|project|qualification/.test(label);
  const wantsAuth = /authoriz|sponsor|start|availab|eligible|work in/.test(label);
  for (const answer of answers) {
    const prompt = answer.prompt.toLocaleLowerCase("en-US");
    if (wantsInterest && prompt.includes("interested")) return answer;
    if (wantsExperience && prompt.includes("relevant experience")) return answer;
    if (wantsAuth && prompt.includes("authorization")) return answer;
  }
  return null;
}

/** Kinds that take typed text. */
const TEXT_KINDS: ReadonlySet<BrowserField["kind"]> = new Set(["text", "email", "tel", "url"]);

/** Kinds that are choices or uploads: never typed into. */
const CHOICE_KINDS: ReadonlySet<BrowserField["kind"]> = new Set(["radio", "checkbox", "select", "file"]);

/** A type-ahead: the value is typed and the matching suggestion picked by the executor (matchSuggestion). */
function suggest(field: BrowserField, value: string, basis: FillDecision["basis"]): FillDecision {
  return {
    fieldId: field.id,
    action: "choose",
    value,
    basis,
    reason: "Typed into the site's suggestion list and picked the matching suggestion.",
    pause: null
  };
}

function fill(
  field: BrowserField,
  value: string,
  basis: FillDecision["basis"],
  reason: string
): FillDecision {
  // A legal or background answer is never echoed in a pause.
  const hidden = basis?.kind === "fact" && isStandardAnswerKey(basis.key);
  // A radio set, checkbox, list, or upload is a choice: a known answer is never typed into it.
  if (CHOICE_KINDS.has(field.kind)) {
    return pauseDecision(field, {
      question: hidden
        ? `"${field.label}" is a choice, and the saved answer is not one of its options. How should it be answered?`
        : `"${field.label}" is a choice; the known answer "${value.slice(0, 80)}" is not one of its options. How should it be answered?`,
      key: basis?.kind === "fact" ? basis.key : null,
      scope: basis?.kind === "fact" ? basis.scope : null,
      safeguard: false
    });
  }
  // A number box accepts only a number; a recorded date or phrase is never
  // reformatted to fit it, so the candidate answers instead.
  if (field.kind === "number" && !/^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    return pauseDecision(field, {
      question: hidden
        ? `"${field.label}" takes a number, and the saved answer is not one. How should it be answered?`
        : `"${field.label}" takes a number, and the known answer ("${value.slice(0, 80)}") is not one. How should it be answered?`,
      key: basis?.kind === "fact" ? basis.key : null,
      scope: basis?.kind === "fact" ? basis.scope : null,
      safeguard: false
    });
  }
  return { fieldId: field.id, action: "fill", value, basis, reason, pause: null };
}

function skip(field: BrowserField, reason: string): FillDecision {
  return { fieldId: field.id, action: "skip", value: null, basis: null, reason, pause: null };
}

function pauseDecision(field: BrowserField, pause: FillDecision["pause"]): FillDecision {
  return { fieldId: field.id, action: "pause", value: null, basis: null, reason: pause?.question ?? "Paused.", pause };
}

/** "United States" matches exactly one "United States +1" / "United States (+1)" option of a phone-country list. */
function dialCodeOption(value: string, options: string[]): string | undefined {
  const escaped = value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}\\s*\\(?\\+\\d{1,4}\\)?$`, "i");
  const matches = options.filter((option) => pattern.test(option.trim()));
  return matches.length === 1 ? matches[0] : undefined;
}

/** A US state's other form among the options: "IL" picks "Illinois", "Illinois" picks "IL"; exactly one, else undefined. */
function stateOption(value: string, options: string[]): string | undefined {
  const alternate = usStateAlternate(value);
  if (!alternate) return undefined;
  const matches = options.filter((option) => option.trim().toLocaleLowerCase("en-US") === alternate);
  return matches.length === 1 ? matches[0] : undefined;
}

/** The ways a country list or a profile spells the United States. */
const US_COUNTRY_KEYS: ReadonlySet<string> = new Set([
  "united states", "united states of america", "us", "usa", "u.s", "u.s.", "u.s.a", "u.s.a."
]);

/** A country name compared loosely: no accents, lowercase, no trailing dialing code ("+1", "(+44)"), no leading "the". */
function countryKey(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("en-US")
    .replace(/\s*\(?\+\d{1,4}\)?\s*$/, "").replace(/\s+/g, " ").trim().replace(/^the /, "");
}

/**
 * The one country option naming the profile's country: the same name
 * (ignoring case, accents, and a dialing code), or any spelling of the
 * United States for a US profile ("USA" picks "United States +1"). Two
 * matches or none: null, and the field pauses.
 */
export function matchCountryOption(value: string, options: string[]): string | null {
  const wanted = countryKey(value);
  if (!wanted) return null;
  const us = US_COUNTRY_KEYS.has(wanted);
  const matches = options.filter((option) => {
    const offered = countryKey(option);
    return offered === wanted || (us && US_COUNTRY_KEYS.has(offered));
  });
  return matches.length === 1 ? matches[0]! : null;
}

const SCHOOL_LABEL = /^(?:school|school name|university|college|school or university|college or university|(?:school|college|university) ?\/ ?(?:school|college|university)|(?:which|what) (?:university|college|school) (?:are you (?:currently )?attending|do you (?:currently )?attend)\??)$/;
const DEGREE_LABEL = /^(?:degree|degree type)$/;
const EDUCATION_DATE_LABEL = /^(start|end) date (month|year)$/;
/** Greenhouse's education date ids ("start-month--0"); its employment block uses "start-date-month--0" with the same English labels. */
const EDUCATION_DATE_ID = /^(?:start|end)-(?:month|year)--\d+$/;
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "2024-08" or "2028-05-15" as a year and month; null otherwise. */
function yearMonthOf(value: string | undefined): { year: string; month: number } | null {
  const match = /^(\d{4})-(\d{2})/.exec(value ?? "");
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year: match[1]!, month } : null;
}

/** The one option naming the month: its full English name, its 3-letter abbreviation, or its number ("8" or "08"). */
function monthOption(month: number, options: string[]): string | null {
  const name = MONTH_NAMES[month - 1]!;
  const accepted = new Set([name, name.slice(0, 3), String(month), String(month).padStart(2, "0")]);
  const matches = options.filter((option) => accepted.has(option.toLocaleLowerCase("en-US").trim().replace(/\.$/, "")));
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * An education block's field (School, Degree, Start/End date month and year),
 * answered from the profile: the school, the degree (chooseDegreeOption,
 * never a B.S. for a B.A.), the education start month, and the run profile's
 * graduation date. Null when the label is not one of these or the value is
 * not on the profile, so the field falls through to the usual rules (an
 * optional field stays empty, a required one pauses). Nothing is derived:
 * no field of study from the degree, no default graduation date on another
 * profile. The dates also need Greenhouse's education ids, because its
 * employment block repeats the same "Start date month" labels and must never
 * take education dates.
 */
function educationDecision(field: BrowserField, education: EducationInputs | undefined): FillDecision | null {
  if (!education) return null;
  const label = normalizedLabel(field.label);
  const options = (field.kind === "select" || field.kind === "radio") ? field.options ?? [] : [];
  if (SCHOOL_LABEL.test(label)) {
    const school = education.school?.trim();
    if (!school) return null;
    const basis = { kind: "profile" as const, field: "school" };
    // A searched list: the full name is typed ("UC Berkeley" as "University of California, Berkeley").
    if (field.widget === "autocomplete") return suggest(field, promptSearchTerms(school)[0] ?? school, basis);
    if (options.length) {
      // The same words, else the one option naming only the campus ("Springfield" for "University of Example, Springfield").
      const option = sameNamedOption(school, options) ?? campusOption(school, options);
      if (option) return { fieldId: field.id, action: "choose", value: option, basis, reason: "The school on your profile.", pause: null };
      return pauseDecision(field, {
        question: `Your profile says "${school}" for "${field.label}", which is not one of its options. Which option should be chosen?`.slice(0, 500),
        key: null,
        scope: null,
        safeguard: false
      });
    }
    return TEXT_KINDS.has(field.kind) ? fill(field, school, basis, "The school on your profile.") : null;
  }
  if (DEGREE_LABEL.test(label)) {
    const degree = education.degree?.trim();
    if (!degree) return null;
    const basis = { kind: "profile" as const, field: "degree" };
    if (options.length) {
      const option = chooseDegreeOption({
        key: "college", school: education.school ?? "", level: bachelorKind(degree) ? "bachelor" : "other",
        degree, fieldOfStudy: null, gpa: null, startYear: null, endYear: null
      }, options);
      if (option) return { fieldId: field.id, action: "choose", value: option, basis, reason: "The degree on your profile.", pause: null };
      return pauseDecision(field, {
        question: `Your profile degree "${degree}" matches none of the options for "${field.label}". Which option should be chosen?`.slice(0, 500),
        key: null,
        scope: null,
        safeguard: false
      });
    }
    return TEXT_KINDS.has(field.kind) && field.widget !== "autocomplete" ? fill(field, degree, basis, "The degree on your profile.") : null;
  }
  const date = EDUCATION_DATE_ID.test(field.id) ? EDUCATION_DATE_LABEL.exec(label) : null;
  if (!date) return null;
  const start = date[1] === "start";
  const value = start ? yearMonthOf(education.startMonth) : yearMonthOf(education.graduation?.date);
  if (!value) return null;
  const basis: NonNullable<FillDecision["basis"]> = start
    ? { kind: "profile", field: "educationStartMonth" }
    : education.graduation!.basis;
  const reason = start ? "The education start month on your profile." : "The graduation date this application uses.";
  if (date[2] === "month") {
    if (!options.length) return null;
    const option = monthOption(value.month, options);
    if (option) return { fieldId: field.id, action: "choose", value: option, basis, reason, pause: null };
    const name = MONTH_NAMES[value.month - 1]!;
    return pauseDecision(field, {
      question: `"${field.label}" has no option for ${name.charAt(0).toUpperCase()}${name.slice(1)}. Which option should be chosen?`,
      key: null,
      scope: null,
      safeguard: false
    });
  }
  if (field.widget === "autocomplete") return suggest(field, value.year, basis);
  if (field.kind === "number" || TEXT_KINDS.has(field.kind)) return fill(field, value.year, basis, reason);
  if (options.length) {
    const option = options.find((entry) => entry.trim() === value.year);
    if (option) return { fieldId: field.id, action: "choose", value: option, basis, reason, pause: null };
    return pauseDecision(field, {
      question: `"${field.label}" has no option for ${value.year}. Which option should be chosen?`,
      key: null,
      scope: null,
      safeguard: false
    });
  }
  return null;
}

/**
 * A whole GPA label on a 4.0 scale ("GPA", "Undergraduate GPA", "Cumulative GPA",
 * "What is your GPA?", "GPA (out of 4.0)"). A major, departmental, high-school,
 * weighted, term, or other-scale GPA never matches, so it is never answered
 * with the profile GPA.
 */
const GPA_LABEL = /^(?:what is your )?(?:(?:undergraduate|cumulative|current|overall|college|university)\s+)*(?:gpa|grade point average)(?:\s*\(?(?:out of|on a)\s+4(?:\.0+)?(?:\s+scale)?\)?)?(?:\s*\(?(?:if applicable)\)?)?\??$/;
const PROFILE_GPA = /^[0-4]\.\d{1,3}$/;
const GPA_NUMBER = String.raw`(\d(?:\.\d+)?)`;

/** "3.691" as "3.69": truncated, never rounded up, so it never overstates. */
function twoDecimalGpa(gpa: string): string {
  const [whole, fraction = ""] = gpa.split(".");
  return `${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

/** Whether a GPA list option's range holds the GPA; null when the option names no range it can read. */
function gpaOptionContains(option: string, gpa: number, twoDecimals: string): boolean | null {
  const text = option.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
  const between = new RegExp(`${GPA_NUMBER}\\s*(?:-|–|—|to)\\s*${GPA_NUMBER}`).exec(text);
  if (between) return gpa >= Number(between[1]) && gpa <= Number(between[2]);
  const below = new RegExp(`\\b(?:below|under|less than)\\s+${GPA_NUMBER}`).exec(text);
  if (below) return gpa < Number(below[1]);
  const atLeast = new RegExp(`${GPA_NUMBER}\\s*\\+|${GPA_NUMBER}\\s+(?:and above|or higher)\\b|\\b(?:above|at least)\\s+${GPA_NUMBER}`).exec(text);
  if (atLeast) return gpa >= Number(atLeast[1] ?? atLeast[2] ?? atLeast[3]) && gpa <= 4;
  const plain = new RegExp(`^${GPA_NUMBER}$`).exec(text);
  if (plain) return Number(plain[1]) === Number(twoDecimals);
  return null;
}

/**
 * A GPA field answered from the profile's GPA: a text or number box takes it
 * with two decimals (truncated; the saved precision only when the label asks
 * for three decimals), and a list or radio set takes the one option whose
 * range holds it. Null when the label is not a whole 4.0-scale GPA label or
 * no valid GPA is saved, so the usual rules apply (a required field pauses).
 */
function gpaDecision(field: BrowserField, gpa: string | undefined): FillDecision | null {
  const label = normalizedLabel(field.label);
  if (!GPA_LABEL.test(label) || field.widget === "autocomplete") return null;
  const saved = gpa?.trim();
  if (!saved || !PROFILE_GPA.test(saved)) return null;
  const basis = { kind: "profile" as const, field: "gpa" };
  const twoDecimals = twoDecimalGpa(saved);
  if (field.kind === "text" || field.kind === "number") {
    return fill(field, /\b(?:three|3) decimal/.test(label) ? saved : twoDecimals, basis, "The GPA on your profile.");
  }
  if ((field.kind === "select" || field.kind === "radio") && field.options?.length) {
    const value = Number(saved);
    const matches = field.options.filter((option) => gpaOptionContains(option, value, twoDecimals) === true);
    if (matches.length === 1) {
      return { fieldId: field.id, action: "choose", value: matches[0]!, basis, reason: "The GPA on your profile falls in this option's range.", pause: null };
    }
    return pauseDecision(field, {
      question: `Your profile GPA fits none or several of the options for "${field.label}". Which option should be chosen?`.slice(0, 500),
      key: null,
      scope: null,
      safeguard: false
    });
  }
  return null;
}

/** "he/him" matches "He/Him/His": the saved pronouns are a prefix of exactly one option's. */
function matchPronounOption(saved: string, options: string[]): string | undefined {
  const tokens = (text: string) => text.split("/").map((token) => token.trim().toLocaleLowerCase("en-US")).filter(Boolean);
  const wanted = tokens(saved);
  if (wanted.length === 0) return undefined;
  const matches = options.filter((option) => {
    const offered = tokens(option);
    return wanted.length <= offered.length && wanted.every((token, index) => offered[index] === token);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function pauseRecord(field: BrowserField, decision: FillDecision, sensitive: boolean): PauseRecord {
  return {
    fieldId: field.id,
    label: field.label,
    question: decision.pause?.question ?? `How should "${field.label}" be answered?`,
    suggestedKey: decision.pause?.key ?? null,
    suggestedScope: decision.pause?.scope ?? null,
    safeguard: decision.pause?.safeguard ?? false,
    sensitive,
    upload: field.kind === "file",
    status: "open",
    answer: null,
    draft: null,
    fieldKind: field.kind,
    ...(field.options?.length ? { options: field.options } : {})
  };
}

export type { RecognizedForm };

/** The plain reason a data-retention or processing consent checkbox waits for the candidate. */
export const CONSENT_QUESTION = "consent checkbox: needs your OK";

const CONSENT_PATTERN = /\b(?:consent|agree|authori[sz]e)\b[^.]{0,120}\b(?:retain|retention|store|storing|process|processing|keep)\b[^.]{0,80}\b(?:data|information|details)\b|\bretain my (?:data|information)\b/i;

/** A checkbox asking the candidate's consent to keep or process their data ("… has my consent to retain my data … for up to 3 years"). */
export function isConsentCheckbox(label: string): boolean {
  return CONSENT_PATTERN.test(label);
}

/** NFKD, no combining marks, lowercase, single spaces, no trailing punctuation. */
function normalizeSuggestion(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ").trim().replace(/[\s.,;:!?]+$/, "");
}

/**
 * The suggestion a type-ahead should take for a saved value, or null: the
 * one that equals it; else the only one with the same words, ignoring
 * punctuation, case, accents, and the words of/the/at/and/in ("University of
 * California, Davis" takes "University of California - Davis"); else the
 * only one that starts with it; else, for a
 * "City, Region" value, the only "City, …" suggestion that names the region
 * as a whole word, trying a US state's other form next ("Springfield, IL"
 * takes "Springfield, Illinois, United States"; "Springfield, Illinois" takes
 * "Springfield, IL, USA"). Never a guess between several.
 */
export function matchSuggestion(value: string, options: string[]): string | null {
  const wanted = normalizeSuggestion(value);
  if (!wanted) return null;
  const normalized = options.map((option) => ({ option, text: normalizeSuggestion(option) })).filter((entry) => entry.text);
  const exact = normalized.find((entry) => entry.text === wanted);
  if (exact) return exact.option;
  const key = sameNameKey(value);
  if (key) {
    const named = options.filter((option) => sameNameKey(option) === key);
    if (named.length === 1) return named[0]!;
    if (named.length > 1) return null;
  }
  // A whole-word prefix: "Berkeley, CA" does not start "Berkeley, California".
  const prefixed = normalized.filter((entry) => entry.text.startsWith(wanted) && !/[a-z0-9]/.test(entry.text.charAt(wanted.length)));
  if (prefixed.length === 1) return prefixed[0]!.option;
  if (prefixed.length > 1) return null;
  const comma = wanted.indexOf(",");
  if (comma > 0) {
    const city = wanted.slice(0, comma).trim();
    const region = wanted.slice(comma + 1).trim();
    if (city && region) {
      const alternate = usStateAlternate(region);
      for (const form of alternate ? [region, alternate] : [region]) {
        const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const word = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`);
        const regional = normalized.filter((entry) => entry.text.startsWith(`${city},`) && word.test(entry.text.slice(city.length + 1)));
        if (regional.length === 1) return regional[0]!.option;
        if (regional.length > 1) return null;
      }
    }
  }
  return null;
}

type ContactKey = keyof ContactProfile | "email" | "phone" | "currentLocation";

/**
 * Standard contact labels only, matched against the whole label, so a
 * question like "Which city would you prefer to work in?" never receives the
 * mailing city.
 */
const CONTACT_LABELS: Array<{ key: ContactKey; pattern: RegExp }> = [
  { key: "fullName", pattern: /^(?:full |legal |your )?name$|^full legal name$|^your full name$/ },
  { key: "email", pattern: /^e-?mail(?: address)?$/ },
  { key: "phone", pattern: /^(?:phone|mobile|cell|telephone)(?: phone)?(?: number)?$/ },
  { key: "linkedinUrl", pattern: /^linked ?in(?: profile)?(?: url)?$/ },
  { key: "githubUrl", pattern: /^git ?hub(?: profile)?(?: url)?$/ },
  { key: "currentLocation", pattern: /^(?:current )?location$|^location \(city\)$|^where are you (?:currently )?(?:located|based)\??$/ },
  { key: "preferredName", pattern: /^preferred(?: first)? name(?: \((?:if )?(?:different|applicable)[^)]*\))?\??$|^what is your preferred (?:first )?name\??$|^(?:what )?name (?:do you|would you like to) (?:prefer to )?(?:go by|be called)\??$/ },
  { key: "legalFirstName", pattern: /^(legal )?(first|given) name$/ },
  { key: "legalLastName", pattern: /^(legal )?(last|family) name$|^surname$/ },
  { key: "addressLine1", pattern: /^(street )?address( line)? ?1$|^street address$|^address$/ },
  { key: "addressLine2", pattern: /^address( line)? ?2$|^(apartment|apt|suite|unit)(,? (suite|unit|etc\.?))*$/ },
  { key: "addressCity", pattern: /^city$|^town\/city$|^city\/town$/ },
  { key: "addressRegion", pattern: /^(state|province|region)$|^state\/province$|^state or province$|^(?:what|which) state do you (?:currently )?(?:reside|live) in\??$|^(?:current )?state of residence$/ },
  { key: "addressPostalCode", pattern: /^(postal|zip)( code)?$|^zip\/postal code$|^postal\/zip code$/ },
  { key: "addressCountry", pattern: /^country$|^country \/ territory$|^country\/territory$/ },
  { key: "phoneType", pattern: /^phone (device )?type$|^type of phone$|^phone number type$/ },
  { key: "fieldOfStudy", pattern: /^(field|area) of study$|^major$|^discipline$/ }
];

/** A label compared whole: lowercase, no "(optional)", no required marker, single spaces. */
function normalizedLabel(label: string): string {
  return stripRequiredMarker(label.toLocaleLowerCase("en-US").replace(/\(optional\)/g, "")).label
    .replace(/\s+/g, " ").trim();
}

function contactValue(label: string, profile: PlannerInputs["profile"]): { key: ContactKey; value: string } | null {
  const normalized = normalizedLabel(label);
  for (const { key, pattern } of CONTACT_LABELS) {
    if (pattern.test(normalized)) {
      const value = contactField(key, profile)?.trim();
      return value ? { key, value } : null;
    }
  }
  return null;
}

function contactField(key: ContactKey, profile: PlannerInputs["profile"]): string | undefined {
  if (key === "currentLocation") {
    // "City, Region" only when both are on the profile.
    const city = profile.addressCity?.trim();
    const region = profile.addressRegion?.trim();
    return city && region ? `${city}, ${region}` : undefined;
  }
  return profile[key];
}
