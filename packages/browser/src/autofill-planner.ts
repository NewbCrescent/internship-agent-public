import type {
  AvailabilityWindow,
  BrowserField,
  FillDecision,
  PauseRecord,
  RecognizedForm
} from "@internship-agent/domain";
import { citizenAuthorizationOption, factOption, FACT_OPTION_KEYS, isStandardizedTestTypeQuestion, priorInternshipThreshold, samePlace, savedYesNoOption, SITE_VALUE_KEPT_REASON, UNCONFIRMED_SITE_VALUE_REASON } from "@internship-agent/domain";
import { asksForAllSchools, asksForHighSchool, schoolsAttendedLines, type EducationRow, type HighSchoolPlace } from "@internship-agent/domain";
import { clipDecisionText, internshipTermAnswer, onSiteRelocationOption } from "@internship-agent/domain";
import { bachelorKind, campusOption, checkboxAnswer, chooseDegreeOption, fieldOfStudyCategoryOption, isStandardAnswerKey, matchOfferedOption, namedSchoolRelation, promptSearchTerms, sameNameKey, sameNamedOption, standardAnswerOption, usPersonYesNoOption } from "@internship-agent/domain";

import { classifyFieldRole, classifyUploadRole, isSensitiveRole } from "./ats/field-roles";
import { HISPANIC_CHECKBOX_REASON, RACE_ONLY_DECLINE_REASON, VETERAN_CLASSIFICATION_EMPTY_REASON, type SelfIdentificationRule } from "./ats/self-identification";
import { isHearAboutQuestion, pickHearAboutOption } from "./ats/hear-about";
import { US_STATE_NAMES_BY_CODE, usStateAlternate } from "./ats/us-states";
import { isListSearchBox, isSafeguardField, isSignupField, stripRequiredMarker } from "./form-recognition";
import { standingFieldDecision, textMessageConsentDecision, type StandingInputs } from "./standing-fields";

export type FieldResolution =
  | {
      status: "RESOLVED";
      key: string;
      scope: string;
      display: string;
      value: boolean | string;
      /** (Track 62) the candidate saved U.S. citizenship as Yes and this is a Yes to U.S. work authorization; it may pick the one option citizenship makes true. */
      usCitizen?: true;
      /** (Track 89) a saved on-site Yes on a U.S. posting with a saved U.S.-wide relocation Yes; it may pick the one "Yes, I will relocate …" option. */
      usRelocation?: true;
    }
  | { status: "NEEDS_INPUT"; key: string | null; scope: string | null }
  | {
      status: "UNAVAILABLE";
      /** The catalog recognized the question, but no saved answer settles it (it needs confirmation, is ambiguous, or has no saved fact). */
      held?: true;
    }
  /** A saved voluntary self-identification answer matched exactly one offered option, or the race-only rule chose the list's decline option (ats/self-identification.ts). */
  | { status: "SELF_IDENTIFIED"; key: string; option: string; rule?: SelfIdentificationRule }
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
  /** The posting's places ("City, Region" or its stated text), for "are you located in or near the city" options. */
  postingLocations?: string[];
  /** The candidate's schools, for questions that name high school or ask for every school attended (the candidate's rule, 2026-11-26). */
  schools?: SchoolInputs;
  /** (Track 83, set by planAutofill) Another field on the form asks the city or ZIP/postal code. */
  addressSplit?: boolean;
  /** (Track 89) The saved internship availability window (user-saved start and end dates), for term and availability questions. */
  availability?: AvailabilityWindow;
};

export type SchoolInputs = { rows: EducationRow[]; highSchoolPlace?: HighSchoolPlace };

export type EducationInputs = {
  school?: string;
  degree?: string;
  /** YYYY-MM, from the profile. */
  startMonth?: string;
  /** The run profile's graduation date (YYYY-MM-DD) and where it came from; absent when that profile has none. */
  graduation?: { date: string; basis: NonNullable<FillDecision["basis"]> };
  /** (Track 83, set by planAutofill) The form has a "Still Student?" box. */
  stillStudentAsked?: boolean;
  /** (Track 83, set by planAutofill) The form's Ashby education End Date year list has no option for the graduation year. */
  endYearMissing?: boolean;
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
export function planAutofill(form: RecognizedForm, planned: PlannerInputs): AutofillPlan {
  const inputs = withAddressFormFlag(form, withEducationFormFlags(form, planned));
  const decisions: FillDecision[] = [];
  const pauses: PauseRecord[] = [];
  let safeguardHalt = false;

  for (const [index, field] of form.fields.entries()) {
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
    if (isSignupField(field)) {
      decisions.push(skip(field, "A job-alert or newsletter signup box is not part of the application; it stays empty."));
      continue;
    }
    if (isListSearchBox(field)) {
      decisions.push(skip(field, "A list's search box is not a question; it stays empty."));
      continue;
    }
    const role = classifyFieldRole(field);
    // The candidate's text-message rule (standing-fields.ts) comes before the standing settings, which count every text opt-in as marketing.
    if (!isSensitiveRole(role)) {
      const texts = textMessageConsentDecision(field);
      if (texts) {
        decisions.push(texts);
        if (texts.action === "pause" && texts.pause) pauses.push(pauseRecord(field, texts, false));
        continue;
      }
    }
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
      // exactly one offered option matches (or, under the candidate's race-only
      // rule of 2026-11-26, the list's one decline option); a veteran classification
      // that the saved veteran answer leaves empty stays empty (Track 82); otherwise
      // the candidate answers in-session and nothing is stored.
      const saved = inputs.resolutions.get(field.id);
      if (saved?.status === "SELF_IDENTIFIED" && saved.rule === "veteran_classification_empty") {
        decisions.push(skip(field, VETERAN_CLASSIFICATION_EMPTY_REASON));
        continue;
      }
      // (Track 90) Oracle's single "I am Hispanic or Latino." box, checked or left empty, with one reason for both.
      if (saved?.status === "SELF_IDENTIFIED" && field.kind === "checkbox" && saved.rule === "hispanic_checkbox_empty") {
        decisions.push(skip(field, HISPANIC_CHECKBOX_REASON));
        continue;
      }
      if (saved?.status === "SELF_IDENTIFIED" && field.kind === "checkbox" && saved.rule === "hispanic_checkbox_checked") {
        decisions.push({ fieldId: field.id, action: "check", value: "true", basis: { kind: "fact", key: saved.key, scope: "global" }, reason: HISPANIC_CHECKBOX_REASON, pause: null });
        continue;
      }
      if (saved?.status === "SELF_IDENTIFIED" && (field.kind === "select" || field.kind === "radio" || (field.kind === "checkbox" && (field.options?.length ?? 0) >= 2)) &&
        field.options?.includes(saved.option)) {
        decisions.push({
          fieldId: field.id,
          action: "choose",
          value: saved.option,
          basis: { kind: "fact", key: saved.key, scope: "global" },
          reason: saved.rule === "race_only_decline" ? RACE_ONLY_DECLINE_REASON : "Your saved voluntary self-identification answer matches one of the offered options.",
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
    const followUp = otherFollowUpDecision(field, index > 0 ? form.fields[index - 1] : undefined, decisions);
    if (followUp) {
      decisions.push(followUp);
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

/**
 * (Track 83) The education inputs with what the whole form says: a "Still Student?" box, and an Ashby education End
 * Date year list without the graduation year. Unchanged when the run has no education inputs.
 */
function withEducationFormFlags(form: RecognizedForm, inputs: PlannerInputs): PlannerInputs {
  const education = inputs.education;
  if (!education) return inputs;
  const stillStudentAsked = form.fields.some(isStillStudentBox);
  const year = yearMonthOf(education.graduation?.date)?.year;
  const endYearMissing = year !== undefined && form.fields.some((field) => {
    const date = ASHBY_EDUCATION_DATE_LABEL.exec(normalizedLabel(field.label));
    return date?.[1] === "end" && date[2] === "year" && (field.options?.length ?? 0) > 0 && !field.options!.some((option) => option.trim() === year);
  });
  if (!stillStudentAsked && !endYearMissing) return inputs;
  return { ...inputs, education: { ...education, stillStudentAsked, endYearMissing } };
}

/** (Track 83) The inputs with `addressSplit`: whether another field on the form is labelled as a city or ZIP/postal code. */
function withAddressFormFlag(form: RecognizedForm, inputs: PlannerInputs): PlannerInputs {
  const patterns = CONTACT_LABELS.filter((entry) => entry.key === "addressCity" || entry.key === "addressPostalCode").map((entry) => entry.pattern);
  const addressSplit = form.fields.some((field) => {
    const label = normalizedLabel(field.label).replace(/[\s:?*]+$/, "");
    return patterns.some((pattern) => pattern.test(label));
  });
  return addressSplit ? { ...inputs, addressSplit } : inputs;
}

const PREFIXED_ADDRESS = /^(?:permanent|mailing|home|current|residential)(?: street)? address$/;
const WHOLE_ADDRESS = /^(?:full|complete) (?:(?:permanent|mailing|home|current|residential) )?address$|^(?:(?:permanent|mailing|home|current|residential) )?address \((?:street,? )?(?:including )?city,? state,? (?:and )?zip(?: code)?\)$/;

/**
 * (Track 83) An address asked whole ("Full address", "Address (City, State, Zip)", or a text area labelled "Address" or
 * "Home Address") gets the profile address on one line, only when street, city, state and ZIP are all on the profile.
 * A bare "Mailing / Home / Permanent / Current Address" text box gets the street line when the form asks the city or
 * ZIP separately. "(Home|Mailing|Permanent) Street Address" keeps the existing contact rule. Null otherwise.
 */
function addressDecision(field: BrowserField, inputs: PlannerInputs): FillDecision | null {
  if (field.widget === "autocomplete") return null;
  const label = normalizedLabel(field.label).replace(/[\s:*]+$/, "");
  const street = / street address$/.test(label);
  const profile = inputs.profile;
  const textBox = TEXT_KINDS.has(field.kind);
  if (WHOLE_ADDRESS.test(label) ? textBox || field.kind === "textarea" : field.kind === "textarea" && !street && (label === "address" || PREFIXED_ADDRESS.test(label))) {
    const [line1, line2, city, region, postal, country] = [profile.addressLine1, profile.addressLine2, profile.addressCity, profile.addressRegion, profile.addressPostalCode, profile.addressCountry]
      .map((part) => part?.trim() ?? "");
    if (!line1 || !city || !region || !postal) return null;
    const abroad = country && matchCountryOption(country, ["United States"]) === null ? `, ${country}` : "";
    return fill(field, `${line1}${line2 ? `, ${line2}` : ""}, ${city}, ${region} ${postal}${abroad}`, { kind: "profile", field: "address" }, "The address on your profile, on one line.");
  }
  if (textBox && !street && PREFIXED_ADDRESS.test(label) && inputs.addressSplit) {
    const line1 = profile.addressLine1?.trim();
    return line1 ? fill(field, line1, { kind: "profile", field: "addressLine1" }, "The street line of the address on your profile (the form asks city and ZIP separately).") : null;
  }
  return null;
}

function decideField(field: BrowserField, inputs: PlannerInputs): FillDecision {
  const resolution = inputs.resolutions.get(field.id);

  // A question that names high school or asks for every school comes first, so the contact and college rules never answer it; it returns null for every other label, so field-of-study and current-location lists still reach profileListDecision below.
  const school = schoolQuestionDecision(field, inputs.schools, resolution);
  if (school) return school;

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
          reason: "Your rule for “How did you hear about us?”: your saved answer, else a job board, else LinkedIn, else another board, N/A, Other, or any non-referral option.",
          pause: null
        };
      }
    } else if (field.currentValue && !field.options?.length) {
      // A Workday prompt that already shows a pick is read without its options: keep it.
      return keepShown(field, resolution);
    }
  }

  const address = addressDecision(field, inputs);
  if (address) return address;
  const surveyCountry = surveyCountryDecision(field, inputs.profile);
  if (surveyCountry) return surveyCountry;

  const contact = contactValue(field.label, inputs.profile);
  // A phone question asked as a number box (an Ashby Number question labelled "Phone", Track 67) takes the profile
  // phone's digits only: a number box takes no "+", spaces, brackets, or dashes. Fewer than 7 or more than 15 digits is no phone.
  if (contact?.key === "phone" && field.kind === "number" && field.widget !== "autocomplete") {
    const digits = contact.value.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      return fill(field, digits, { kind: "profile", field: "phone" }, "The phone number on your profile, digits only (this box takes only numbers).");
    }
  }
  // (Track 79) A profile link, name, or address line asked in a text area ("LinkedIn Profile" as a textarea) is typed like a text box.
  const contactArea = contact !== null && field.kind === "textarea" && field.widget !== "autocomplete" && TEXTAREA_CONTACT_KEYS.has(contact.key) &&
    !(contact.key === "addressLine1" && contact.label === "address");
  if (contact && (TEXT_KINDS.has(field.kind) || contactArea || field.kind === "select" || field.kind === "radio")) {
    // A phone-country picker that already shows the profile's country ("🇺🇸 (+1) United States of America") is
    // kept, never retyped: typing into it first clears the country it shows (Track 37). A bare "+1" names no country.
    if (contact.key === "addressCountry" && field.currentValue && matchCountryOption(contact.value, [field.currentValue])) {
      return keepShown(field, resolution);
    }
    if (field.widget === "autocomplete") {
      // A Country type-ahead searches by the country's name: a "US" / "USA" profile value types "United States".
      const typed = contact.key === "addressCountry" && US_COUNTRY_KEYS.has(countryKey(contact.value)) ? "United States" : typeAheadText(contact, field.options);
      return suggest(field, typed, { kind: "profile", field: contact.key });
    }
    if (TEXT_KINDS.has(field.kind) || contactArea) return fill(field, contact.value, { kind: "profile", field: contact.key }, "Contact details from your profile.");
    const match = field.options?.find((option) => option.toLocaleLowerCase("en-US") === contact.value.toLocaleLowerCase("en-US"))
      ?? dialCodeOption(contact.value, field.options ?? [])
      ?? (contact.key === "addressCountry" ? matchCountryOption(contact.value, field.options ?? []) ?? undefined : undefined)
      ?? (contact.key === "addressRegion" ? stateOption(contact.value, field.options ?? []) : undefined)
      ?? (contact.key === "phoneType" ? phoneTypeOption(contact.value, field.options ?? []) : undefined);
    if (match) {
      return { fieldId: field.id, action: "choose", value: match, basis: { kind: "profile", field: contact.key }, reason: "Contact details from your profile.", pause: null };
    }
    const listed = profileListDecision(field, contact, inputs.profile);
    if (listed) return listed;
    return pauseDecision(field, {
      question: `Your profile says "${contact.value}" for "${field.label}", which is not one of its options. Which option should be chosen?`,
      key: null,
      scope: null,
      safeguard: false
    });
  }

  const education = educationDecision(field, inputs.education, inputs.standing?.today);
  if (education) return education;
  const gpa = gpaDecision(field, inputs.profile.gpa);
  if (gpa) return gpa;
  const scale = gpaScaleDecision(field, inputs.profile.gpa);
  if (scale) return scale;
  const csMajor = csMajorDecision(field, inputs);
  if (csMajor) return csMajor;
  const namedSchool = namedSchoolDecision(field, inputs, resolution);
  if (namedSchool) return namedSchool;
  // (Track 89) A term or availability question answered from the saved availability window.
  const term = internshipTermAnswer(field, inputs.availability);
  if (term) {
    return term.action === "fill"
      ? fill(field, term.value, AVAILABILITY_BASIS, term.reason)
      : { fieldId: field.id, action: term.action, value: term.value, basis: AVAILABILITY_BASIS, reason: term.reason, pause: null };
  }

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
      const year = graduationYearDecision(field, resolution) ?? graduationTextDecision(field, resolution);
      if (year) return year;
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
      // (Track 83) a saved ACT "not taken" never picks a literal "No" option.
      if (matches.length === 1 && resolution.key !== "act_taken") {
        return {
          fieldId: field.id,
          action: "choose",
          value: matches[0]!,
          basis: { kind: "fact", key: resolution.key, scope: resolution.scope },
          reason: "A remembered fact matches one of the offered options.",
          pause: null
        };
      }
      // (Track 82) Saved pronouns pick a longer option of a checkbox group ("He/him/his"), as on a list.
      const pronoun = resolution.key === "pronouns" ? matchPronounOption(resolution.display, field.options!) : undefined;
      if (pronoun) {
        return {
          fieldId: field.id,
          action: "choose",
          value: pronoun,
          basis: { kind: "fact", key: resolution.key, scope: resolution.scope },
          reason: "A remembered fact matches one of the offered options.",
          pause: null
        };
      }
      // (Track 79) A checkbox group gets the same option rules as a list: a term, range, or comparison for the
      // graduation date, a standard answer's option, and a sentence Yes/No ("Yes, I am at least 18 years of age.").
      const picked = factOptionDecision(field, resolution, inputs);
      if (picked) return picked;
      const option = standardAnswerOption(resolution.key, resolution.value, field.options!) ?? savedYesNoOption(resolution.key, resolution.value, field.options!);
      if (option) {
        return {
          fieldId: field.id,
          action: "choose",
          value: option,
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
      return keepShown(field, resolution);
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
    const year = graduationYearDecision(field, resolution) ?? graduationTextDecision(field, resolution);
    if (year) return year;
    const start = startDateDecision(field, resolution);
    if (start) return start;
    const picked = factOptionDecision(field, resolution, inputs);
    if (picked) return picked;
    if (field.widget === "autocomplete" && field.kind === "select") {
      // A searched list whose options were read on opening types the option as the site shows it.
      const offered = field.options?.length
        ? field.options.find((option) => option.toLocaleLowerCase("en-US") === resolution.display.toLocaleLowerCase("en-US"))
          ?? (resolution.key === "pronouns" ? matchPronounOption(resolution.display, field.options) : undefined)
          ?? (standardAnswerOption(resolution.key, resolution.value, field.options) ?? undefined)
        : undefined;
      if (offered === undefined) {
        const citizen = citizenOption(field, resolution);
        if (citizen) return suggest(field, citizen, CITIZEN_BASIS);
      }
      return suggest(field, offered ?? resolution.display, { kind: "fact", key: resolution.key, scope: resolution.scope });
    }
    if ((field.kind === "select" || field.kind === "radio") && field.options) {
      const match = field.options.find((option) =>
        option.toLocaleLowerCase("en-US") === resolution.display.toLocaleLowerCase("en-US")
      ) ?? (resolution.key === "pronouns" ? matchPronounOption(resolution.display, field.options) : undefined)
        ?? (standardAnswerOption(resolution.key, resolution.value, field.options) ?? undefined)
        ?? (usPersonYesNoOption(field.label, resolution.key, resolution.value, field.options) ?? undefined)
        ?? (savedYesNoOption(resolution.key, resolution.value, field.options) ?? undefined);
      if (!match) {
        const citizen = citizenOption(field, resolution);
        if (citizen) return { fieldId: field.id, action: "choose", value: citizen, basis: CITIZEN_BASIS, reason: CITIZEN_OPTION_REASON, pause: null };
      }
      if (!match && resolution.usRelocation && resolution.value === true) {
        const moving = onSiteRelocationOption(field.options, inputs.availability);
        if (moving) {
          return { fieldId: field.id, action: "choose", value: moving, basis: { kind: "fact", key: resolution.key, scope: resolution.scope }, reason: "You are open to on-site work and willing to relocate anywhere in the U.S. (your saved answers).", pause: null };
        }
      }
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
    return keepShown(field, resolution);
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

/** A saved fact whose value picks an offered option by a rule (packages/domain fact-options.ts); the salary rule is never typed or suggested. */
function factOptionDecision(field: BrowserField, resolution: Extract<FieldResolution, { status: "RESOLVED" }>, inputs: PlannerInputs): FillDecision | null {
  if (!FACT_OPTION_KEYS.has(resolution.key)) return null;
  const basis = { kind: "fact" as const, key: resolution.key, scope: resolution.scope };
  const listed = ((field.kind === "select" || field.kind === "radio") && field.widget !== "autocomplete" && field.options?.length) ||
    (field.kind === "checkbox" && (field.options?.length ?? 0) >= 2) ? field.options! : null;
  // A combined "located near the city, or relocate at your own expense?" list is decided only by its rule:
  // its plain "No" would also deny living near the city, so a saved No never picks it.
  const relocation = resolution.key === "willing_to_relocate_at_own_expense";
  // (Track 83) A saved "did not take the ACT" picks only a "did not take" option; its "No" is never chosen or typed.
  const actTaken = resolution.key === "act_taken";
  const exact = !relocation && !actTaken && listed?.some((option) => option.toLocaleLowerCase("en-US") === resolution.display.toLocaleLowerCase("en-US"));
  const picked = listed && !exact ? factOption(resolution.key, resolution.value, listed, {
    today: inputs.standing?.today,
    nearPosting: samePlace(contactField("currentLocation", inputs.profile), inputs.postingLocations),
    degreeLevel: inputs.education?.degree && bachelorKind(inputs.education.degree) ? "bachelor" : null,
    question: field.label,
    closest: /\b(?:closest|nearest)\b/.test(normalizedLabel(field.label)),
    regionCode: profileRegionCode(inputs.profile.addressRegion)
  }) : null;
  if (picked) return { fieldId: field.id, action: "choose", value: picked.option, basis, reason: picked.reason, pause: null };
  // (Track 87) An "at least one previous internship" Yes/No takes Yes or No from the saved count, never the count itself:
  // a text box gets the word, and a list or other control without its one Yes or No option pauses.
  const threshold = resolution.key === "prior_internships_count" ? priorInternshipThreshold(field.label) : null;
  if (threshold !== null && typeof resolution.value === "string" && /^\d{1,2}$/.test(resolution.value)) {
    if (!listed && (TEXT_KINDS.has(field.kind) || field.kind === "textarea") && field.widget !== "autocomplete") {
      return fill(field, Number(resolution.value) >= threshold ? "Yes" : "No", basis, "Read from your saved number of previous internships.");
    }
    return pauseDecision(field, {
      question: `The saved answer is not among the options for "${field.label}". How should it be answered?`,
      key: resolution.key,
      scope: resolution.scope,
      safeguard: false
    });
  }
  // (Track 79) Which test a saved score is for: only its own "SAT" / "ACT" option, never the score typed or echoed.
  if ((resolution.key === "sat_score" || resolution.key === "act_score") && isStandardizedTestTypeQuestion(field.label)) {
    return pauseDecision(field, {
      question: `No single option of "${field.label}" names the test your saved score is for. How should it be answered?`,
      key: resolution.key,
      scope: resolution.scope,
      safeguard: false
    });
  }
  if ((resolution.key === "salary_expectation_rule" || actTaken || (relocation && listed)) && !exact) {
    return pauseDecision(field, {
      question: `The saved answer is not among the options for "${field.label}". How should it be answered?`,
      key: resolution.key,
      scope: resolution.scope,
      safeguard: false
    });
  }
  return null;
}

/** (Track 83) The profile's state as a two-letter code ("CA", or "California" read as CA); undefined otherwise. */
function profileRegionCode(region: string | undefined): string | undefined {
  const text = region?.trim();
  if (!text) return undefined;
  if (/^[a-z]{2}$/i.test(text)) return text.toUpperCase();
  const code = usStateAlternate(text);
  return code && /^[a-z]{2}$/i.test(code) ? code.toUpperCase() : undefined;
}

/** A graduation date asked for as a year only ("Expected graduation year"): the year option, or the year typed. */
function graduationYearDecision(field: BrowserField, resolution: Extract<FieldResolution, { status: "RESOLVED" }>): FillDecision | null {
  if (resolution.key !== "graduation_date" || typeof resolution.value !== "string") return null;
  const date = /^(\d{4})-\d{2}-\d{2}$/.exec(resolution.value);
  const label = normalizedLabel(field.label);
  if (!date || !/\byear\b/.test(label) || /\b(?:month|date|day)\b/.test(label)) return null;
  const year = date[1]!;
  const basis = { kind: "fact" as const, key: resolution.key, scope: resolution.scope };
  if (field.widget === "autocomplete") return suggest(field, year, basis);
  if ((field.kind === "select" || field.kind === "radio") && field.options?.length) {
    const matches = field.options.filter((option) => option.trim() === year);
    if (matches.length === 1) return { fieldId: field.id, action: "choose", value: matches[0]!, basis, reason: "The year of your graduation date.", pause: null };
    return null; // usual rules: the existing "not among the options" pause
  }
  if (field.kind === "text" || field.kind === "number") return fill(field, year, basis, "The year of your graduation date.");
  return null;
}

/**
 * (Track 79) A graduation date typed as a month and year: "MM/YYYY" when the label says so ("When are you expected to
 * graduate? (MM/YYYY)"), "<Month> YYYY" when it asks for the month and year ("What is your anticipated graduation month
 * and year?"). Null otherwise, so the date is typed as saved.
 */
function graduationTextDecision(field: BrowserField, resolution: Extract<FieldResolution, { status: "RESOLVED" }>): FillDecision | null {
  if (resolution.key !== "graduation_date" || typeof resolution.value !== "string" || field.widget === "autocomplete") return null;
  if (field.kind !== "text" && field.kind !== "textarea") return null;
  const date = /^(\d{4})-(\d{2})-\d{2}$/.exec(resolution.value);
  if (!date) return null;
  const month = Number(date[2]);
  if (month < 1 || month > 12) return null;
  const label = normalizedLabel(field.label);
  const basis = { kind: "fact" as const, key: resolution.key, scope: resolution.scope };
  if (label.includes("mm/yyyy")) return fill(field, `${date[2]}/${date[1]}`, basis, "Your graduation date as month and year, in the format this field takes.");
  const monthName = new RegExp(`\\(e\\.?g\\.?,? (?:${MONTH_NAMES.join("|")}) 20\\d\\d\\)`);
  if (/\bmonth (?:and|&) year\b|\bmonth\/year\b/.test(label) || monthName.test(label)) {
    const name = MONTH_NAMES[month - 1]!;
    return fill(field, `${name.charAt(0).toUpperCase()}${name.slice(1)} ${date[1]}`, basis, "Your graduation date as month and year.");
  }
  return null;
}

/** The saved available start date typed in the format the field takes: a date input YYYY-MM-DD; a text box the label's hint (DD/MM/YYYY, YYYY-MM-DD, MM-DD-YYYY), else MM/DD/YYYY. */
function startDateDecision(field: BrowserField, resolution: Extract<FieldResolution, { status: "RESOLVED" }>): FillDecision | null {
  if (resolution.key !== "available_start_date" || typeof resolution.value !== "string" || field.widget === "autocomplete") return null;
  if (field.kind !== "date" && field.kind !== "text" && field.kind !== "textarea") return null;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(resolution.value);
  if (!date) return null;
  const [, year, month, day] = date;
  const label = normalizedLabel(field.label);
  const value = field.kind === "date" ? `${year}-${month}-${day}`
    : label.includes("dd/mm/yyyy") ? `${day}/${month}/${year}`
    : label.includes("yyyy-mm-dd") ? `${year}-${month}-${day}`
    : label.includes("mm-dd-yyyy") ? `${month}-${day}-${year}`
    : `${month}/${day}/${year}`;
  return fill(field, value, { kind: "fact", key: resolution.key, scope: resolution.scope }, "Your saved available start date, in the format this field takes.");
}

const MOBILE_PHONE_TYPE = /^(?:mobile|cell(?:ular)?)(?: phone)?$/i;
const MOBILE_OPTION = /\b(?:mobile|cell|cellular)\b/i;
const NOT_PERSONAL = /\b(?:work|business|corporate|office|company)\b/i;

/** A saved "Mobile" phone type picks the one personal or home mobile option ("Home Mobile", "Personal Mobile Phone", "Mobile - Personal"); never a work or corporate mobile. Undefined otherwise. */
function phoneTypeOption(saved: string, options: readonly string[]): string | undefined {
  if (!MOBILE_PHONE_TYPE.test(saved.trim())) return undefined;
  const matches = options.filter((option) => MOBILE_OPTION.test(option) && !NOT_PERSONAL.test(option));
  return matches.length === 1 ? matches[0] : undefined;
}

const OTHER_FOLLOW_UP = /^if (?:you )?(?:selected|chose|picked|answered) ["“']?other["”']?,? (?:please )?(?:specify|list|enter|name|tell us)\b/;

/** "If you selected other, please specify" right after a list the plan answered with a listed (non-"Other") option: N/A when required, else left empty. */
function otherFollowUpDecision(field: BrowserField, previous: BrowserField | undefined, decisions: FillDecision[]): FillDecision | null {
  if (!previous || previous.widget === "autocomplete" || !(field.kind === "text" || field.kind === "textarea") || !OTHER_FOLLOW_UP.test(normalizedLabel(field.label))) return null;
  if (!(previous.options ?? []).some((option) => /^other\b/i.test(option.trim()))) return null;
  const chosen = [...decisions].reverse().find((decision) => decision.fieldId === previous.id);
  if (chosen?.action !== "choose" || !chosen.value || /^other\b/i.test(chosen.value.trim())) return null;
  if (!field.required) return skip(field, "The list before this question was answered with a listed option, so this follow-up stays empty.");
  return {
    fieldId: field.id,
    action: "fill",
    value: "N/A",
    basis: null,
    reason: "The list before this question was answered with a listed option, so this follow-up does not apply.",
    pause: null
  };
}

type PackageIntent = "interest" | "experience" | "authorization";

/**
 * A package answer fills a text box only when the box asks the same thing as
 * the answer's prompt: the whole label (normalized by `packageQuestionText`)
 * must be one of the phrasings below, never a label that merely contains a
 * word such as "why", "company", "project", or "experience". Anything else
 * (a technical "why" question, "Which company…", "Describe a project where…",
 * "How many years of experience…", "Explain why…") falls through to the
 * usual rules.
 */
function matchPackageAnswer(
  field: BrowserField,
  answers: PlannerInputs["packageAnswers"]
): PlannerInputs["packageAnswers"][number] | null {
  // A package answer is prose: only a text box or text area takes it, never a choice.
  if (field.kind !== "text" && field.kind !== "textarea") return null;
  const intent = packageQuestionIntent(field.label);
  if (!intent) return null;
  return answers.find((answer) => packagePromptIntent(answer.prompt) === intent) ?? null;
}

/** Which package answer a prompt is (the writer's three prompts); null for any other prompt. */
function packagePromptIntent(prompt: string): PackageIntent | null {
  const text = prompt.toLocaleLowerCase("en-US");
  if (text.includes("interested")) return "interest";
  if (text.includes("relevant experience")) return "experience";
  if (text.includes("authorization")) return "authorization";
  return null;
}

/** Lowercase, no required marker or "(optional)", straight apostrophes, no trailing length hint or end punctuation. */
function packageQuestionText(label: string): string {
  return normalizedLabel(label)
    .replace(/[‘’]/g, "'")
    .replace(/\s*\([^()]*\b(?:words?|characters?|chars?)\b[^()]*\)\s*$/, "")
    .replace(/[\s?.!:]+$/, "")
    .trim();
}

// One word of a role description or an employer's name: never a connective or
// question word, so "CPX vs NVL72" or "this role and why" is not a name.
const PACKAGE_WORD = String.raw`(?!(?:and|or|vs|versus|which|what|how|why|that|who|whom|where|when|if|explain|describe|compare|compared)\b)[\p{L}\p{N}][\p{L}\p{N}&.'-]*`;
const PACKAGE_NAME = String.raw`${PACKAGE_WORD}(?: ${PACKAGE_WORD}){0,4}`;
const PACKAGE_ROLE_NOUN = String.raw`(?:role|position|job|internship|opportunity|program|programme|team|company|organization|organisation|firm)`;
const PACKAGE_ROLE = String.raw`(?:this|the|our) (?:${PACKAGE_WORD} ){0,4}?${PACKAGE_ROLE_NOUN}(?: (?:at|with) ${PACKAGE_NAME})?`;
const PACKAGE_PLACE = String.raw`(?:us|${PACKAGE_ROLE}|${PACKAGE_NAME})`;
const packagePattern = (source: string) => new RegExp(`^(?:${source})$`, "u");

/** Whole-label phrasings of "why are you interested in this role / company, what motivates you to apply". */
const PACKAGE_INTEREST: readonly RegExp[] = [
  packagePattern(String.raw`why (?:are|were) you (?:so )?(?:interested in|excited about|drawn to|applying (?:for|to)) ${PACKAGE_ROLE}`),
  packagePattern(String.raw`why (?:are|were) you (?:so )?(?:interested in|excited about) (?:joining|working (?:at|for|with)) ${PACKAGE_PLACE}`),
  packagePattern(String.raw`why (?:do you want|would you like) (?:to apply (?:for|to) )?${PACKAGE_ROLE}`),
  packagePattern(String.raw`why (?:do you want|would you like) to (?:(?:work|intern) (?:here|(?:at|for|with) ${PACKAGE_PLACE})|join ${PACKAGE_PLACE})`),
  packagePattern(String.raw`why (?:this|the|our) ${PACKAGE_ROLE_NOUN}(?: (?:at|with) ${PACKAGE_NAME})?|why us`),
  packagePattern(String.raw`what (?:interests|excites|motivates|attracts|draws) you (?:to|about) (?:${PACKAGE_ROLE}|(?:working (?:at|for|with)|joining) ${PACKAGE_PLACE})`),
  packagePattern(String.raw`what makes you (?:interested in|excited about) ${PACKAGE_ROLE}`),
  packagePattern(String.raw`what (?:motivates|motivated|made|makes|prompted) you (?:to )?(?:want to )?apply(?: (?:for|to) ${PACKAGE_PLACE})?`),
  packagePattern(String.raw`why (?:are you applying|did you apply)(?: (?:for|to) ${PACKAGE_PLACE})?`)
];

const EXPERIENCE_NOUN = String.raw`(?:experience|background|qualifications)`;

/** Whole-label phrasings of "describe your (most) relevant experience / background". */
const PACKAGE_EXPERIENCE: readonly RegExp[] = [
  packagePattern(String.raw`(?:please )?(?:briefly )?(?:describe|summari[sz]e|tell us about|share|walk us through) (?:your|any) (?:most )?(?:relevant )?(?:(?:work|professional|prior|previous|past) )?${EXPERIENCE_NOUN}(?: (?:and|or) (?:${EXPERIENCE_NOUN}|skills))?(?: (?:for|relevant to|related to) ${PACKAGE_ROLE})?`),
  packagePattern(String.raw`what (?:is|are) your (?:most )?relevant ${EXPERIENCE_NOUN}(?: (?:for|to) ${PACKAGE_ROLE})?`),
  packagePattern(String.raw`what (?:relevant )?${EXPERIENCE_NOUN} do you have(?: (?:that (?:is|are) )?(?:relevant to|related to|for) ${PACKAGE_ROLE})?`),
  packagePattern(String.raw`(?:your )?(?:most )?relevant (?:experience|background)`)
];

const AUTHORIZATION_NOUN = String.raw`(?:current )?work (?:authori[sz]ation|eligibility)(?: status)?(?: (?:and|&) (?:availability|start date|sponsorship(?: (?:needs|requirements|status))?))?`;

/** Whole-label work-authorization or availability summary prompts; never a yes/no question, whose scope may differ. */
const PACKAGE_AUTHORIZATION: readonly RegExp[] = [
  packagePattern(String.raw`what (?:is|are) your ${AUTHORIZATION_NOUN}`),
  packagePattern(String.raw`(?:please )?(?:describe|summari[sz]e|state|share) your ${AUTHORIZATION_NOUN}`),
  packagePattern(AUTHORIZATION_NOUN),
  packagePattern(String.raw`what is your availability|(?:please )?(?:describe|state|share) your availability`)
];

/** What a text question asks, when it is exactly one of the package's three questions; otherwise null. */
function packageQuestionIntent(label: string): PackageIntent | null {
  const text = packageQuestionText(label);
  if (!text || text.length > 200) return null;
  if (PACKAGE_INTEREST.some((pattern) => pattern.test(text))) return "interest";
  if (PACKAGE_EXPERIENCE.some((pattern) => pattern.test(text))) return "experience";
  if (PACKAGE_AUTHORIZATION.some((pattern) => pattern.test(text))) return "authorization";
  return null;
}

/** Kinds that take typed text. */
const TEXT_KINDS: ReadonlySet<BrowserField["kind"]> = new Set(["text", "email", "tel", "url"]);

/** (Track 79) Profile details also typed into a text area. */
const TEXTAREA_CONTACT_KEYS: ReadonlySet<ContactKey> = new Set<ContactKey>(["linkedinUrl", "githubUrl", "portfolioUrl", "fullName", "addressLine1"]);

/** Kinds that are choices or uploads: never typed into. */
const CHOICE_KINDS: ReadonlySet<BrowserField["kind"]> = new Set(["radio", "checkbox", "select", "file"]);

/** A type-ahead: the value is typed and the matching suggestion picked by the executor (matchSuggestion). */
const CITIZEN_BASIS = { kind: "fact", key: "us_citizen", scope: "global" } as const;
const AVAILABILITY_BASIS = { kind: "fact", key: "available_start_date", scope: "global" } as const;
const CITIZEN_OPTION_REASON = "Your saved U.S. citizenship answer makes this the one true work-authorization option.";

/** (Track 62) The one work-authorization option the saved U.S. citizenship makes true, for a U.S. authorization Yes marked `usCitizen`; null otherwise. */
function citizenOption(field: BrowserField, resolution: Extract<FieldResolution, { status: "RESOLVED" }>): string | null {
  return resolution.usCitizen && resolution.value === true && field.options?.length ? citizenAuthorizationOption(field.options) : null;
}

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

/**
 * Leaves the value a field already shows. Only a field no saved answer of the
 * candidate's applies to (or "How did you hear about us?", answered by its own
 * rule) is marked as the site's shown value, which does not hold an automatic
 * submission; a recognized question that nothing saved settles, or one whose
 * saved answer did not fit, is marked unconfirmed (submission-mode.ts).
 */
function keepShown(field: BrowserField, resolution: FieldResolution | undefined): FillDecision {
  const settledByNothing = resolution === undefined ||
    (resolution.status === "UNAVAILABLE" && !resolution.held) ||
    (resolution.status === "RESOLVED" && resolution.key === "how_heard");
  return {
    fieldId: field.id,
    action: "keep",
    value: field.currentValue ?? null,
    basis: null,
    reason: settledByNothing ? SITE_VALUE_KEPT_REASON : UNCONFIRMED_SITE_VALUE_REASON,
    pause: null
  };
}

function skip(field: BrowserField, reason: string): FillDecision {
  return { fieldId: field.id, action: "skip", value: null, basis: null, reason, pause: null };
}

function pauseDecision(field: BrowserField, pause: FillDecision["pause"]): FillDecision {
  // Every planner pause is bounded here (Track 72): a question quoting a long label and a long saved answer (the coursework list) failed the whole run.
  const bounded = pause ? { ...pause, question: clipDecisionText(pause.question) } : null;
  return { fieldId: field.id, action: "pause", value: null, basis: null, reason: bounded?.question ?? "Paused.", pause: bounded };
}

/** "United States" matches exactly one "United States +1" / "United States (+1)" / "+1 (United States)" option of a phone-country list. */
function dialCodeOption(value: string, options: string[]): string | undefined {
  const escaped = value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}\\s*\\(?\\+\\d{1,4}\\)?$`, "i");
  const leading = new RegExp(`^\\(?\\+\\d{1,4}\\)?\\s*\\(\\s*${escaped}\\s*\\)$`, "i");
  const matches = options.filter((option) => pattern.test(option.trim()) || leading.test(option.trim()));
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

/**
 * A country name compared loosely: no accents, lowercase, no leading flag or dialing code
 * ("🇺🇸 (+1) United States of America", Eightfold's phone picker), no trailing dialing code ("+1", "(+44)"),
 * no parentheses around what is left ("+1 (United States)", Oracle's phone picker), no leading "the".
 */
function countryKey(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/^\s*[\u{1F1E6}-\u{1F1FF}]{2}\s*/u, "")
    .replace(/^\(?\+\d{1,4}\)?\s*/, "").toLocaleLowerCase("en-US")
    .replace(/\s*\(?\+\d{1,4}\)?\s*$/, "").replace(/\s+/g, " ").trim()
    .replace(/^\((.*)\)$/, "$1").trim().replace(/^the /, "");
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

// (Track 89) Also "Current school or university:", "What college/university do you attend?", "What is the name of your university?", "Start typing your school's name…".
const SCHOOL_LABEL = /^(?:school|school name|university|college|school or university|college or university|(?:school|college|university) ?\/ ?(?:school|college|university)|(?:which|what) (?:university|college|school) (?:are you (?:currently )?attending|do you (?:currently )?attend|did you attend)\??|current (?:school|university|college)(?: or (?:university|college))?|(?:what|which) (?:college|university|school) ?\/ ?(?:college|university|school) do you (?:currently )?attend\??|what is the name of your (?:university|college|school)\??|please select your current (?:school|university|college)(?: from the list below)?|(?:which|what) (?:university|college|school) are you currently attending(?: or did you last attend)?\??|start typing your school'?s name(?:…|\.\.\.)?)$/;
// (Track 89) "… Select "Other" if not listed", "Please select "Other (School Not Listed)" if your school is not listed."
const OTHER_IF_UNLISTED = /\s*(?:please )?select ["“]?other(?: \([^)]*\))?["”]? if (?:your school is |it is |it's )?not listed\.?$/;
// (Track 89) Words too common in school names to tell two schools apart.
const SCHOOL_COMMON_WORDS = new Set(["university", "univ", "college", "school", "institute", "institution", "technology", "state", "the", "and", "for", "of", "at", "campus", "main", "community"]);
const DEGREE_LABEL = /^(?:degree|degree type)$/;
/** "What degree level are you currently pursuing, or have you most recently completed?": answered like a Degree list. */
const DEGREE_PURSUING_LABEL = /^(?:what|which) (?:degree|degree level|level of degree|type of degree|degree type) are you (?:currently )?pursuing(?:,? or (?:have (?:you )?)?(?:most )?recently completed)?\??$/;
/**
 * (Track 79) The degree level being studied ("What degree program are you actively enrolled in?", "Current Program
 * Type") or held at graduation ("Level of education completed once you've graduated?").
 */
const DEGREE_LEVEL_LABEL = /^(?:what|which) (?:degree|degree program|program|level of degree|type of degree) are you (?:actively |currently )?(?:enrolled in|pursuing|taking|working towards)(?: currently)?\??$|^if you are (?:currently )?enrolled in (?:a )?(?:university|college)(?: or college)?,? what degree are you currently pursuing\??$|^what degree are you taking currently\??$|^current program type$|^level of education completed once you(?:'|’)?ve graduated\??$/;
const AT_GRADUATION_LABEL = /^level of education completed once you/;
const BACHELOR_LEVEL_OPTION = /\b(?:bachelor'?s?|undergrad\w*)\b|\bb\.?\s?[as]\.?(?![a-z])/i;
const NOT_BACHELOR_LEVEL_OPTION = /\b(?:master'?s?|m\.?s\.|doctor\w*|ph\.?\s?d|mba|associate'?s?|post-?grad\w*|non-degree|bootcamp|certificate|not (?:currently )?enrolled|jd)\b/i;

/**
 * (Track 79) The one bachelor's-level option for a degree-level question, for a bachelor's degree on the profile whose
 * graduation date is still ahead (a question about the degree held at graduation needs only the degree). Null when the
 * degree is not a bachelor's, the date has passed or is unknown, or no option or several fit.
 */
function degreeLevelOption(label: string, education: EducationInputs, options: readonly string[], today: string | undefined): string | null {
  if (!education.degree || bachelorKind(education.degree) === null) return null;
  if (!AT_GRADUATION_LABEL.test(label)) {
    const graduation = education.graduation?.date;
    if (!graduation || !today || graduation <= today) return null;
  }
  const hits = options.filter((option) => {
    const text = option.replace(/[‘’]/g, "'");
    return BACHELOR_LEVEL_OPTION.test(text) && !NOT_BACHELOR_LEVEL_OPTION.test(text);
  });
  return hits.length === 1 ? hits[0]! : null;
}

const EDUCATION_DATE_LABEL = /^(start|end) date (month|year)$/;
/** (Track 83) Ashby's unlabeled education month and year lists, as the executor labels them ("Education End Date year"). */
const ASHBY_EDUCATION_DATE_LABEL = /^education (start|end) date (month|year)$/;
const STILL_STUDENT_LABEL = /^(?:still (?:a )?student|currently (?:a )?student|currently attending|currently enrolled)\??$/;

/** (Track 83) An education block's "Still Student?" box (Ashby's `_systemfield_education_history-isCurrent`). */
function isStillStudentBox(field: BrowserField): boolean {
  if (field.kind !== "checkbox" || (field.options?.length ?? 0) > 1) return false;
  return field.id.includes("education_history-isCurrent") || STILL_STUDENT_LABEL.test(normalizedLabel(field.label));
}
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
 * (Track 89) For a list that asks for "Other" when the school is not listed: its one "Other" option, only when the list
 * has fewer than 500 options (a 500-option list may be cut short) and no other option shares a distinctive word with
 * the profile's school (it might be the school under another name). Null otherwise.
 */
function unlistedSchoolOption(school: string, options: readonly string[]): string | null {
  if (options.length >= 500) return null;
  const words = (text: string) => new Set((text.toLocaleLowerCase("en-US").match(/[a-z0-9]+/g) ?? []).filter((word) => word.length >= 3 && !SCHOOL_COMMON_WORDS.has(word)));
  const own = words(school);
  const others = options.filter((option) => /^other\b/i.test(option.trim()));
  if (others.length !== 1) return null;
  const shared = options.some((option) => !/^other\b/i.test(option.trim()) && [...words(option)].some((word) => own.has(word)));
  return shared ? null : others[0]!;
}

/** The one option naming the school with a trailing US state code ("University of Example--Springfield (IL)"); null for none or several. */
function stateSuffixedOption(school: string, options: string[]): string | null {
  const wanted = sameNameKey(school);
  if (!wanted) return null;
  const matches = options.filter((option) => {
    const suffixed = /^(.*\S)\s*\(([A-Za-z]{2})\)\s*$/.exec(option.trim());
    return Boolean(suffixed && usStateAlternate(suffixed[2]!) && sameNameKey(suffixed[1]!) === wanted);
  });
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
 * take education dates. Ashby's education lists are read by their executor
 * label ("Education Start Date month"); its "Still Student?" box is ticked
 * while the graduation date is ahead, and then an End Date whose year list
 * stops before the graduation year stays empty, month and year (Track 83).
 */
function educationDecision(field: BrowserField, education: EducationInputs | undefined, today?: string): FillDecision | null {
  if (!education) return null;
  const label = normalizedLabel(field.label);
  const options = (field.kind === "select" || field.kind === "radio") ? field.options ?? [] : [];
  // (Track 79) A degree-level question may also be a checkbox group of two or more options.
  const levelOptions = field.kind === "checkbox" && (field.options?.length ?? 0) >= 2 ? field.options! : options;
  const schoolLabel = label.replace(OTHER_IF_UNLISTED, "").replace(/[\s:]+$/, "").trim();
  if (SCHOOL_LABEL.test(schoolLabel)) {
    const school = education.school?.trim();
    if (!school) return null;
    const basis = { kind: "profile" as const, field: "school" };
    // A searched list: the full name is typed ("UC Berkeley" as "University of California, Berkeley").
    if (field.widget === "autocomplete") return suggest(field, promptSearchTerms(school)[0] ?? school, basis);
    if (options.length) {
      // The same words, else the one option naming only the campus ("Springfield" for "University of Example, Springfield").
      // Also the one option naming it with a trailing US state code ("University of Example--Springfield (IL)").
      const option = sameNamedOption(school, options) ?? campusOption(school, options) ?? stateSuffixedOption(school, options);
      if (option) return { fieldId: field.id, action: "choose", value: option, basis, reason: "The school on your profile.", pause: null };
      const other = OTHER_IF_UNLISTED.test(label) ? unlistedSchoolOption(school, options) : null;
      if (other) return { fieldId: field.id, action: "choose", value: other, basis, reason: "The school on your profile is not on this list, and the question asks for Other then.", pause: null };
      return pauseDecision(field, {
        question: `Your profile says "${school}" for "${field.label}", which is not one of its options. Which option should be chosen?`.slice(0, 500),
        key: null,
        scope: null,
        safeguard: false
      });
    }
    return TEXT_KINDS.has(field.kind) ? fill(field, school, basis, "The school on your profile.") : null;
  }
  const levelLabel = DEGREE_LEVEL_LABEL.test(label);
  if (DEGREE_LABEL.test(label) || DEGREE_PURSUING_LABEL.test(label) || levelLabel) {
    const degree = education.degree?.trim();
    if (!degree) return null;
    const basis = { kind: "profile" as const, field: "degree" };
    const listed = levelLabel || label === "degree type" ? levelOptions : options;
    // A degree-level wording asked as a text box keeps its usual rules (the degree is typed only for "Degree" labels).
    const levelOnly = levelLabel && !DEGREE_LABEL.test(label) && !DEGREE_PURSUING_LABEL.test(label);
    if (levelOnly && !listed.length) return null;
    // A question about the degree being studied now needs the graduation date still ahead.
    if (levelOnly && !AT_GRADUATION_LABEL.test(label) && !(education.graduation?.date && today && education.graduation.date > today)) return null;
    if (listed.length) {
      const option = chooseDegreeOption({
        key: "college", school: education.school ?? "", level: bachelorKind(degree) ? "bachelor" : "other",
        degree, fieldOfStudy: null, gpa: null, startYear: null, endYear: null
      }, [...listed]);
      if (option) return { fieldId: field.id, action: "choose", value: option, basis, reason: "The degree on your profile.", pause: null };
      const level = levelLabel || label === "degree type" ? degreeLevelOption(label, education, listed, today) : null;
      if (level) return { fieldId: field.id, action: "choose", value: level, basis, reason: "The degree level on your profile.", pause: null };
      return pauseDecision(field, {
        question: `Your profile degree "${degree}" matches none of the options for "${field.label}". Which option should be chosen?`.slice(0, 500),
        key: null,
        scope: null,
        safeguard: false
      });
    }
    return TEXT_KINDS.has(field.kind) && field.widget !== "autocomplete" ? fill(field, degree, basis, "The degree on your profile.") : null;
  }
  const ahead = Boolean(education.graduation?.date && today && education.graduation.date > today);
  if (isStillStudentBox(field)) {
    if (!ahead) return null;
    return {
      fieldId: field.id,
      action: "check",
      value: "true",
      basis: education.graduation!.basis,
      reason: "Your graduation date is still ahead, so you are still a student.",
      pause: null
    };
  }
  const ashby = ASHBY_EDUCATION_DATE_LABEL.exec(label);
  const date = (EDUCATION_DATE_ID.test(field.id) ? EDUCATION_DATE_LABEL.exec(label) : null) ?? ashby;
  if (!date) return null;
  if (ashby && ashby[1] === "end" && education.endYearMissing && education.stillStudentAsked && ahead) {
    return skip(field, "You are still a student: the end date stays empty and Still Student? is ticked.");
  }
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

type HighSchoolDetail = "name" | "startYear" | "endYear" | "city" | "region" | "postalCode" | "place";

const HIGH_SCHOOL_BASIS: Record<HighSchoolDetail, string> = {
  name: "highSchoolName",
  startYear: "highSchoolStartYear",
  endYear: "highSchoolEndYear",
  city: "highSchoolCity",
  region: "highSchoolRegion",
  postalCode: "highSchoolPostalCode",
  place: "highSchoolPlace"
};

const HIGH_SCHOOL_DETAIL_WORDS: Record<HighSchoolDetail, string> = {
  name: "name",
  startYear: "start year",
  endYear: "graduation year",
  city: "city",
  region: "state",
  postalCode: "ZIP code",
  place: "city and state"
};

const WHEN_WORDS = /\b(?:year|date|when)\b/;
const HIGH_SCHOOL_NAME_LABEL = /^(?:(?:name of (?:your |the )?)?(?:high|secondary) school(?: name| attended)?|(?:what|which) (?:high|secondary) school did you (?:attend|graduate from)\??|(?:high|secondary) school(?: name)? ?(?:\/|or) ?ged(?: name)?)$/;

/** Which high-school detail a label that names high school asks for, or null when it asks for none this rule answers. */
function highSchoolDetailOf(label: string): HighSchoolDetail | null {
  if (/\b(?:graduat\w*|completion|completed|finished|end)\b/.test(label) && WHEN_WORDS.test(label)) return "endYear";
  if (/\b(?:start|started|began|entered)\b/.test(label) && WHEN_WORDS.test(label)) return "startYear";
  if (/\b(?:zip|postal)\b/.test(label)) return "postalCode";
  if (/\blocation\b|\bcity(?:,| and| ?\/) ?state\b/.test(label)) return "place";
  if (/\bcity\b/.test(label)) return "city";
  if (/\b(?:state|province)\b/.test(label)) return "region";
  if (HIGH_SCHOOL_NAME_LABEL.test(label)) return "name";
  return null;
}

/** The one option equal to `value`, ignoring case, or undefined. */
function exactOption(value: string, options: string[]): string | undefined {
  const wanted = value.trim().toLocaleLowerCase("en-US");
  const matches = options.filter((option) => option.trim().toLocaleLowerCase("en-US") === wanted);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The candidate's rule (2026-11-26) for questions about schools: a question
 * asking for every school attended gets one line per school (the college,
 * then the high school), and a question naming high school, secondary school,
 * or GED gets the high school's saved name, start or graduation year, city,
 * state, ZIP code, or "City, State" — typed, searched, or the one option that
 * fits. Nothing saved, or no fitting option, pauses when required and skips
 * when optional; a high-school question never takes the college's graduation
 * date. Null leaves the field to the other rules.
 */
function schoolQuestionDecision(field: BrowserField, schools: SchoolInputs | undefined, resolution: FieldResolution | undefined): FillDecision | null {
  const label = normalizedLabel(field.label);
  const rows = schools?.rows ?? [];
  const place = schools?.highSchoolPlace ?? {};
  if (asksForAllSchools(label)) {
    if (field.kind !== "text" && field.kind !== "textarea") return null;
    const lines = schoolsAttendedLines(rows, place);
    if (!lines) return null;
    return fill(field, lines.join(field.kind === "textarea" ? "\n" : "; "), { kind: "profile", field: "education" },
      "Every school on your profile: the college, then the high school (your rule of 2026-11-26).");
  }
  if (!asksForHighSchool(label)) return null;
  const detail = highSchoolDetailOf(label);
  const pause = (question: string) => pauseDecision(field, { question: question.slice(0, 500), key: null, scope: null, safeguard: false });
  if (!detail) {
    if (resolution?.status === "RESOLVED" && resolution.key === "graduation_date") {
      return field.required
        ? pause(`“${field.label}” asks about your high school; the saved graduation date is your college's, so it is not used here. What should it say?`)
        : skip(field, `“${field.label}” asks about your high school; the saved graduation date is your college's, so it stays empty.`);
    }
    return null;
  }
  const highSchool = rows.find((row) => row.key === "high_school");
  const year = (value: number | null | undefined) => (value === null || value === undefined ? undefined : String(value));
  const city = place.city?.trim() || undefined;
  const region = place.region?.trim() || undefined;
  const values: Record<HighSchoolDetail, string | undefined> = {
    name: highSchool?.school.trim() || undefined,
    startYear: year(highSchool?.startYear),
    endYear: year(highSchool?.endYear),
    city,
    region,
    postalCode: place.postalCode?.trim() || undefined,
    place: city && region ? `${city}, ${region}` : undefined
  };
  const yearDetail = detail === "startYear" || detail === "endYear";
  if (yearDetail && ((/\bdate\b/.test(label) && !/\b(?:year|when)\b/.test(label)) || field.kind === "date")) {
    return field.required
      ? pause(`Only your high school's ${detail === "startYear" ? "start" : "end"} year is saved; enter the date yourself.`)
      : skip(field, `Only your high school's ${detail === "startYear" ? "start" : "end"} year is saved, so this optional date stays empty.`);
  }
  const value = values[detail];
  if (!value) {
    return field.required
      ? pause(`Nothing saved states your high school's ${HIGH_SCHOOL_DETAIL_WORDS[detail]} for “${field.label}”. What should it say?`)
      : skip(field, "An optional high-school field with nothing saved stays empty.");
  }
  const basis = { kind: "profile" as const, field: HIGH_SCHOOL_BASIS[detail] };
  const reason = "Your high school on your profile (asked for by name; your rule of 2026-11-26).";
  if (field.widget === "autocomplete") return suggest(field, value, basis);
  if ((field.kind === "select" || field.kind === "radio") && field.options?.length) {
    const options = field.options;
    const option = detail === "name" ? sameNamedOption(value, options) ?? undefined
      : yearDetail ? options.find((entry) => entry.trim() === value)
      : detail === "region" ? stateOption(value, options) ?? exactOption(value, options)
      : exactOption(value, options);
    if (option) return { fieldId: field.id, action: "choose", value: option, basis, reason, pause: null };
    return pause(`Your profile says “${value}” for “${field.label}”, which is not one of its options. Which option should be chosen?`);
  }
  if (TEXT_KINDS.has(field.kind) || field.kind === "textarea" || (field.kind === "number" && yearDetail)) return fill(field, value, basis, reason);
  return null;
}

/**
 * A whole GPA label on a 4.0 scale ("GPA", "Undergraduate GPA", "Cumulative GPA",
 * "What is your GPA?", "GPA (out of 4.0)"), or a sentence asking for it
 * (GPA_SENTENCE_LABEL). A major, departmental, high-school, weighted, term, or
 * other-scale GPA never matches, so it is never answered with the profile GPA.
 */
const GPA_LABEL = /^(?:(?:what is|what's|whats|what was|what is\/was) your )?(?:(?:undergraduate|cumulative|current|overall|college|university|most current|most recent|college\/university|university\/college|current or final|current or most recent|final)\s+)*(?:gpa|grade point average)(?:\s*\(?(?:out of|on a|normalized to a)\s+4(?:\.0+)?(?:\s+scale)?\)?)?(?:\s*\((?:undergraduate|undergrad)\))?(?:\s*\(?(?:if applicable)\)?)?\??$/;
/** "Please specify the overall average grade (GPA) for your last/current degree:" (Veeva on Lever, 2026-11-26), "Please enter your GPA". */
const GPA_SENTENCE_LABEL = /^(?:please )?(?:specify|enter|select|provide|indicate|state)(?: your| the)?(?: overall| cumulative| current)?(?: average)?(?: grade(?: point average)?)? \(?gpa\)?(?: for your (?:last\/current|current\/last|current|most recent|last or current|current or most recent) degree)?[:?.]?$/;
const PROFILE_GPA = /^[0-4]\.\d{1,3}$/;
const GPA_NUMBER = String.raw`(\d(?:\.\d+)?)`;

/** "3.691" as "3.69": truncated, never rounded up, so it never overstates. */
function twoDecimalGpa(gpa: string): string {
  const [whole, fraction = ""] = gpa.split(".");
  return `${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

/** The most decimals any number in the option has ("3.3 - 3.69" is 2); null when it names no number. */
function optionDecimals(option: string): number | null {
  const numbers = option.match(/\d+(?:\.\d+)?/g);
  if (!numbers) return null;
  return Math.max(...numbers.map((number) => number.split(".")[1]?.length ?? 0));
}

/** "3.695" truncated to `decimals` places as a number (never rounded up). */
function truncatedGpa(gpa: string, decimals: number): number {
  const [whole, fraction = ""] = gpa.split(".");
  return decimals > 0 ? Number(`${whole}.${fraction.slice(0, decimals) || "0"}`) : Number(whole);
}

/** Whether a GPA list option's range holds the GPA; null when the option names no range it can read. */
/** (Track 79) "3.5+", "3.5 and above", "at least 3.5": the threshold of an at-least option; null for any other option. */
function gpaAtLeastThreshold(option: string): number | null {
  const text = option.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
  const match = new RegExp(`^${GPA_NUMBER}\\s*(?:\\+|and above|or higher)$|^(?:above|at least)\\s+${GPA_NUMBER}$`).exec(text);
  return match ? Number(match[1] ?? match[2]) : null;
}

function gpaOptionContains(option: string, gpa: number, twoDecimals: string): boolean | null {
  const text = option.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
  const between = new RegExp(`${GPA_NUMBER}\\s*(?:-|–|—|to)\\s*${GPA_NUMBER}`).exec(text);
  if (between) return gpa >= Number(between[1]) && gpa <= Number(between[2]);
  const below = new RegExp(`\\b(?:below|under|less than)\\s+${GPA_NUMBER}`).exec(text);
  if (below) return gpa < Number(below[1]);
  const atLeast = new RegExp(`${GPA_NUMBER}\\s*\\+|${GPA_NUMBER}\\s+(?:and above|or higher)\\b|\\b(?:above|at least)\\s+${GPA_NUMBER}`).exec(text);
  if (atLeast) return gpa >= Number(atLeast[1] ?? atLeast[2] ?? atLeast[3]) && gpa <= 4;
  // (Track 79) "3.6 out of 4.0" is the plain "3.6"; a plain option also equals the GPA read to its own decimals (the truncated pass).
  const plain = new RegExp(`^${GPA_NUMBER}$`).exec(text.replace(/\s*(?:out of|\/)\s*4(?:\.0+)?\.?$/, ""));
  if (plain) return Number(plain[1]) === Number(twoDecimals) || Number(plain[1]) === gpa;
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
  const label = normalizedLabel(field.label).replace(/[‘’]/g, "'");
  // (Track 79) "What is your most current GPA? (If recently graduated, provide your GPA at graduation)": the trailing "(if …)" note is not part of the label.
  const bare = label.replace(/\s*\(if [^)]*\)\s*$/, "");
  // (Track 89) "If you are … within the past 24 months, what is your current or final GPA?", "For your most recent degree, what is/was your GPA …?"
  const core = bare.replace(/^(?:if you (?:are|were|have)\b[^,?]{0,120}|for your (?:most recent|current|last) degree),\s*/, "");
  const isGpa = (text: string) => GPA_LABEL.test(text) || GPA_SENTENCE_LABEL.test(text);
  if (!(isGpa(label) || isGpa(bare) || isGpa(core)) || field.widget === "autocomplete") return null;
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
    // (Track 79) Several "at least" options hold the GPA (">4.0 | 4.0+ | 3.7+ | 3.5+ | 3.2+"): the highest threshold met, which never overstates.
    if (matches.length > 1) {
      const thresholds = matches.map((option) => ({ option, threshold: gpaAtLeastThreshold(option) }));
      if (thresholds.every((entry) => entry.threshold !== null)) {
        const highest = Math.max(...thresholds.map((entry) => entry.threshold!));
        const top = thresholds.filter((entry) => entry.threshold === highest);
        if (top.length === 1) {
          return { fieldId: field.id, action: "choose", value: top[0]!.option, basis, reason: "The highest GPA threshold on this list that the GPA on your profile meets.", pause: null };
        }
      }
    }
    if (matches.length === 0) {
      // Ranges written to two decimals ("3.0 - 3.29", "3.3 - 3.69") leave a three-decimal GPA between them:
      // read it truncated to each option's own decimals, which never moves it up a range.
      const truncated = field.options.filter((option) => {
        const decimals = optionDecimals(option);
        return decimals !== null && gpaOptionContains(option, truncatedGpa(saved, decimals), twoDecimals) === true;
      });
      if (truncated.length === 1) {
        return { fieldId: field.id, action: "choose", value: truncated[0]!, basis, reason: "The GPA on your profile, read to this option's decimals, falls in its range.", pause: null };
      }
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

// (Track 89) "Please specify the grading scale used by your current school.", "Please select the corresponding GPA scale:".
const GPA_SCALE_LABEL = /^(?:please )?(?:select|specify|indicate|choose)(?: the| your)?(?: corresponding)? (?:gpa|grading|grade) scale(?: used by your (?:current )?(?:school|university|college))?[:?.]?$|^(?:gpa|grading) scale[:?]?$/;
const FOUR_POINT = /^(?:0(?:\.0+)?\s*-\s*)?4(?:\.0+)?(?:\s*(?:point|pt))?(?:\s+scale)?$|^(?:out of|on a)\s+4(?:\.0+)?(?:\s+scale)?$/;

/**
 * (Track 89) A GPA scale list answered with its one 4.0-scale option, for a valid profile GPA of at most 4.0 (a
 * profile GPA above 4.0 is not on a 4.0 scale). Null otherwise, so the usual rules apply.
 */
function gpaScaleDecision(field: BrowserField, gpa: string | undefined): FillDecision | null {
  if ((field.kind !== "select" && field.kind !== "radio") || field.widget === "autocomplete" || !field.options?.length) return null;
  if (!GPA_SCALE_LABEL.test(normalizedLabel(field.label))) return null;
  const saved = gpa?.trim();
  if (!saved || !PROFILE_GPA.test(saved) || Number(saved) > 4.0) return null;
  const hits = field.options.filter((option) => FOUR_POINT.test(option.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim()));
  return hits.length === 1
    ? { fieldId: field.id, action: "choose", value: hits[0]!, basis: { kind: "profile", field: "gpa" }, reason: "The GPA on your profile is on a 4.0 scale.", pause: null }
    : null;
}

/** "Are you a current college student majoring in computer science (or a related field)?" */
const CS_MAJOR_LABEL = /^are you (?:a |an )?(?:current(?:ly)? )?(?:enrolled )?(?:college |university |undergraduate )?(?:student )?(?:majoring|studying|enrolled) in computer science(,? (?:or|and\/or) (?:a |an )?(?:related|similar|relevant)(?: technical)? (?:field|discipline|major|area)(?: of study)?)?\??$/;

/**
 * "Yes" to a current-computer-science-student question when the profile's
 * field of study is computer science and the graduation date is still ahead
 * of the run's local date. Only "Yes" is ever derived; otherwise null, so the
 * usual rules apply (a required field pauses).
 */
function csMajorDecision(field: BrowserField, inputs: PlannerInputs): FillDecision | null {
  if (field.kind !== "select" && field.kind !== "radio") return null;
  const match = CS_MAJOR_LABEL.exec(normalizedLabel(field.label));
  if (!match) return null;
  const study = inputs.profile.fieldOfStudy?.trim().toLocaleLowerCase("en-US") ?? "";
  const named = study === "computer science" || (Boolean(match[1]) && /\bcomputer sciences?\b/.test(study));
  const graduation = inputs.education?.graduation?.date;
  const today = inputs.standing?.today;
  if (!named || !graduation || !today || graduation <= today) return null;
  const yes = (field.options ?? []).filter((option) => /^yes\b/i.test(option.trim()));
  if (yes.length !== 1) return null;
  return {
    fieldId: field.id,
    action: "choose",
    value: yes[0]!,
    basis: { kind: "profile", field: "fieldOfStudy" },
    reason: "Your profile's field of study is computer science and your graduation date is still ahead.",
    pause: null
  };
}

/** "Are you currently enrolled at <School>?", "Are you an undergrad, masters or PhD student from <School>?", "Do you currently attend <School>?" */
const NAMED_SCHOOL_QUESTION = /^(?:are you\b(.{0,80}?)\b(?:(?:students?|undergrad(?:uate)?s?|enrolled)\s+(?:at|from|of|in)|attending(?:\s+at)?)|do you (?:currently |presently )?attend)\s+(.+?)[\s?.!:]*$/i;
/** Past, future, alumni, staff, transfer, and high-school wordings are not current study at the school; they wait for the candidate. */
const NOT_CURRENT_STUDY = /\b(?:ever|previously|formerly|former|alumn\w*|graduated|graduate of|attended|employ\w*|work(?:ed|ing|s)?|faculty|staff|affiliat\w*|transfer\w*|admitted|accepted|applied|applying|plan(?:ning)? to|intend\w*|incoming|future|prospective|high school|secondary school|exchange|visiting|study abroad)\b/i;
/** Wordings that ask more than current study at the school; only a different school's No may answer them. */
const STUDY_QUALIFIER = /\b(?:full[- ]?time|part[- ]?time|online|evening|honou?rs)\b/i;
const STUDY_LEVEL = /\b(?:undergrad(?:uate)?s?|bachelor'?s?|master'?s|masters|ph\.?\s?d\.?|doctoral|doctorate|graduate|mba)\b/gi;
const UNDERGRADUATE_LEVEL = /^(?:undergrad(?:uate)?s?|bachelor'?s?)$/i;

/**
 * A Yes/No question whether the candidate studies at one named school (Track 57), compared with the profile's school
 * (namedSchoolRelation): another institution is No; the profile's own school is Yes only while the graduation date is
 * still ahead, with no full-time/part-time-style qualifier, and, when the question names levels, with an undergraduate
 * level among them for a bachelor's profile; anything ambiguous returns null so the usual rules apply (a required field
 * pauses). A saved answer for the question (fact, question memory, or recorded wording) comes first.
 */
function namedSchoolDecision(field: BrowserField, inputs: PlannerInputs, resolution: FieldResolution | undefined): FillDecision | null {
  if (field.kind !== "select" && field.kind !== "radio") return null;
  if (field.widget === "autocomplete") return null;
  if (resolution?.status === "RESOLVED" || resolution?.status === "REMEMBERED_ANSWER") return null;
  const label = stripRequiredMarker(field.label.replace(/\(optional\)/gi, "")).label.replace(/\s+/g, " ").trim();
  if (NOT_CURRENT_STUDY.test(label)) return null;
  const match = NAMED_SCHOOL_QUESTION.exec(label);
  if (!match) return null;
  const named = match[2]!
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+(?:this|next|for|during|as of|currently|right now|starting|beginning|in (?:the )?(?:fall|spring|summer|winter|autumn|\d{4}))\b.*$/i, "")
    .replace(/^the\s+/i, "")
    .trim();
  if (!named || /\b(?:or|nor)\b|and\/or|\//i.test(named)) return null;
  if (/^(?:a|an|any|some|your|this|that|our|one|another|accredited|four-year|two-year|2-year|4-year)\b/i.test(named)) return null;
  if (!/\b(?:university|college|institute|polytechnic)\b/i.test(named)) return null;
  const school = inputs.education?.school?.trim();
  if (!school) return null;
  const options = field.options ?? [];
  const pick = (pattern: RegExp): string | null => {
    const found = options.filter((option) => pattern.test(option.trim()));
    return found.length === 1 ? found[0]! : null;
  };
  const relation = namedSchoolRelation(named, school);
  const basis = { kind: "profile" as const, field: "school" };
  if (relation === "different") {
    const no = pick(/^no\b/i);
    return no
      ? { fieldId: field.id, action: "choose", value: no, basis, reason: "The school this question names is a different institution from the school on your profile.", pause: null }
      : null;
  }
  if (relation !== "same" || STUDY_QUALIFIER.test(label)) return null;
  const graduation = inputs.education?.graduation?.date;
  const today = inputs.standing?.today;
  if (!graduation || !today || graduation <= today) return null;
  const levels = label.match(STUDY_LEVEL) ?? [];
  if (levels.length > 0 && !(inputs.education?.degree && bachelorKind(inputs.education.degree) && levels.some((level) => UNDERGRADUATE_LEVEL.test(level)))) return null;
  const yes = pick(/^yes\b/i);
  return yes
    ? { fieldId: field.id, action: "choose", value: yes, basis, reason: "The school this question names is the school on your profile, and your graduation date is still ahead.", pause: null }
    : null;
}

/**
 * "he/him" matches "He/Him/His": the saved pronouns are a prefix of exactly one option's. When saved
 * pronouns naming one set also start a combined option (Rippling's "She/her/hers, they/them/theirs" beside
 * "She/her/hers"), only the options naming one set count.
 */
function matchPronounOption(saved: string, options: string[]): string | undefined {
  const tokens = (text: string) => text.split("/").map((token) => token.trim().toLocaleLowerCase("en-US")).filter(Boolean);
  const wanted = tokens(saved);
  if (wanted.length === 0) return undefined;
  const matches = options.filter((option) => {
    const offered = tokens(option);
    return wanted.length <= offered.length && wanted.every((token, index) => offered[index] === token);
  });
  if (matches.length === 1) return matches[0];
  const oneSet = (text: string) => !/[,;&]| and | or /i.test(text);
  if (matches.length > 1 && oneSet(saved)) {
    const single = matches.filter(oneSet);
    if (single.length === 1) return single[0];
  }
  return undefined;
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
  // A phone-country list ("+1 (United States)", "United States +1"): the one option naming the country, any US spelling.
  const dialing = options.filter((option) => DIALING_CODE_OPTION.some((pattern) => pattern.test(option.replace(/\s+/g, " ").trim())));
  if (dialing.length > 0) return matchCountryOption(value, dialing);
  return null;
}

/** A phone-country option: "+1 (United States)", "+1 United States", or "United States (+1)". */
const DIALING_CODE_OPTION = [/^\(?\+\d{1,4}\)?\s*\((.+)\)$/, /^\(?\+\d{1,4}\)?\s+(.+)$/, /^(.+?)\s*\(?\+\d{1,4}\)?$/];

type ContactKey = keyof ContactProfile | "email" | "phone" | "portfolioUrl" | "currentLocation";

/**
 * Standard contact labels only, matched against the whole label, so a
 * question like "Which city would you prefer to work in?" never receives the
 * mailing city.
 */
const CONTACT_LABELS: Array<{ key: ContactKey; pattern: RegExp }> = [
  { key: "fullName", pattern: /^(?:full |legal |your )?name$|^full legal name$|^your full name$|^first (?:&|and) last name$|^what is your (?:full |legal |full legal )?name\??$/ },
  { key: "email", pattern: /^e-?mail(?: address)?$/ },
  { key: "phone", pattern: /^(?:phone|mobile|cell|telephone)(?: phone)?(?: number)?$/ },
  { key: "linkedinUrl", pattern: /^linked ?in(?: profile)?(?: url| link)?$|^linked ?in (?:profile|profle)(?: url| link)?$|^(?:please )?(?:(?:provide|share|enter|include|add|paste) )?(?:a |the |your )?(?:link|url) (?:to|for|of) (?:your )?linked ?in(?: profile| page)?\.?$/ },
  { key: "githubUrl", pattern: /^git ?hub(?: profile)?(?: url| link)?$|^(?:please )?(?:link|share|provide|enter) (?:to )?(?:a link to )?your git ?hub(?: profile)?$|^git ?hub or (?:personal )?(?:website|portfolio)$/ },
  { key: "portfolioUrl", pattern: /^(?:portfolio|personal website|website|personal site)(?: url| link)?$|^portfolio(?: website)?$/ },
  { key: "currentLocation", pattern: /^(?:current )?location$|^location \(city\)$|^where are you (?:currently )?(?:located|based)\??$|^location ?- ?city and state of residence$|^city and state of residence$|^current city and state$/ },
  { key: "preferredName", pattern: /^preferred(?: first)? name(?: \((?:if )?(?:different|applicable)[^)]*\))?\??$|^what is your preferred (?:first )?name\??$|^(?:what )?name (?:do you|would you like to) (?:prefer to )?(?:go by|be called)\??$/ },
  { key: "legalFirstName", pattern: /^(legal )?(first|given|first\/given) name$/ },
  { key: "legalLastName", pattern: /^(legal )?(last|family|last\/family) name$|^surname$/ },
  { key: "addressLine1", pattern: /^(street )?address( line)? ?1$|^street address$|^address$|^home address(?: line)? ?1$|^(?:home|mailing|permanent) street address$/ },
  { key: "addressLine2", pattern: /^address( line)? ?2$|^(apartment|apt|suite|unit)(,? (suite|unit|etc\.?))*$/ },
  { key: "addressCity", pattern: /^city$|^town\/city$|^city\/town$|^(?:what|which) city do you (?:currently )?(?:reside|live) in\??$|^(?:current )?city of residence$/ },
  { key: "addressRegion", pattern: /^(state|province|region)$|^state\/province$|^state or province$|^(?:what|which) state do you (?:currently )?(?:reside|live) in\??$|^(?:current )?state of residence$|^state abbreviation$/ },
  { key: "addressPostalCode", pattern: /^(postal|zip)( code)?$|^zip\/postal code$|^postal\/zip code$/ },
  { key: "addressCountry", pattern: /^country$|^country \/ territory$|^country\/territory$|^(?:phone )?country(?: phone| dialing)? code(?: picker)?$/ },
  { key: "phoneType", pattern: /^phone (device )?type$|^type of phone$|^phone number type$/ },
  { key: "fieldOfStudy", pattern: /^(field|area) of study$|^major$|^major\(s\)$|^discipline$|^major or field of study$|^field of study or major$|^major ?\/ ?field of study$|^field of study ?\/ ?major$|^what is your major\??$|^(?:please )?(?:select|choose|enter|indicate|specify|provide) your (?:field|area) of study:?$|^what is your (?:field|area) of study\??$|^what is your (?:field|area) of study ?\/ ?(?:degree program|program|major)\??$|^start typing your discipline'?s name(?:…|\.\.\.)?$/ }
];

// (Track 90) Lever's demographic survey opens with "What is your location?" over a list of every country, and shows its
// questions (the ethnicity boxes among them) only once a country is chosen.
const SURVEY_LOCATION_LABEL = /^what is your location$/;
const COUNTRY_LIST_MIN_OPTIONS = 50;

/**
 * (Track 90) "What is your location?" asked as a list of countries (at least COUNTRY_LIST_MIN_OPTIONS options, Lever's
 * demographic survey) takes the one option naming the profile address's country. Any other label, a shorter list (an
 * office list), a text box, or no single matching country: null, so the field is planned as before.
 */
function surveyCountryDecision(field: BrowserField, profile: PlannerInputs["profile"]): FillDecision | null {
  if (field.kind !== "select" || field.widget === "autocomplete" || (field.options?.length ?? 0) < COUNTRY_LIST_MIN_OPTIONS) return null;
  if (!SURVEY_LOCATION_LABEL.test(normalizedLabel(field.label).replace(/[\s:?*]+$/, ""))) return null;
  const country = profile.addressCountry?.trim();
  const option = country ? matchCountryOption(country, field.options ?? []) : null;
  return option
    ? { fieldId: field.id, action: "choose", value: option, basis: { kind: "profile", field: "addressCountry" }, reason: "This list asks only for a country: the country of the address on your profile.", pause: null }
    : null;
}

/**
 * A profile value on a list whose options name it differently: the category
 * naming the field of study, or the country of the profile address for a
 * "Where are you currently located?" list of countries. Null otherwise.
 */
function profileListDecision(field: BrowserField, contact: { key: ContactKey; value: string }, profile: PlannerInputs["profile"]): FillDecision | null {
  if (contact.key === "fieldOfStudy") {
    const option = fieldOfStudyCategoryOption(contact.value, field.options ?? []);
    return option
      ? { fieldId: field.id, action: "choose", value: option, basis: { kind: "profile", field: "fieldOfStudy" }, reason: "The option on this list that names the field of study on your profile.", pause: null }
      : null;
  }
  if (contact.key === "currentLocation") {
    const country = profile.addressCountry?.trim();
    const option = country ? matchCountryOption(country, field.options ?? []) : null;
    return option
      ? { fieldId: field.id, action: "choose", value: option, basis: { kind: "profile", field: "addressCountry" }, reason: "This list asks only for a country: the country of the address on your profile.", pause: null }
      : null;
  }
  return null;
}

/**
 * (Track 83) What a type-ahead is typed for a profile value its suggestions name differently: a two-letter U.S. state
 * code types the state's name ("CA" types "California", so "California, United States" is picked), except in a
 * "State Abbreviation" box; a field of study types the one read option naming its category ("Engineering - Computer
 * Science / Software"). Otherwise the profile value.
 */
function typeAheadText(contact: { key: ContactKey; value: string; label: string }, options: string[] | undefined): string {
  if (contact.key === "addressRegion" && /^[a-z]{2}$/i.test(contact.value) && !/abbreviation/.test(contact.label)) {
    return US_STATE_NAMES_BY_CODE[contact.value.toUpperCase()] ?? contact.value;
  }
  if (contact.key === "fieldOfStudy" && options?.length) return fieldOfStudyCategoryOption(contact.value, options) ?? contact.value;
  return contact.value;
}

/** A label compared whole: lowercase, no "(optional)", no required marker, single spaces. */
function normalizedLabel(label: string): string {
  return stripRequiredMarker(label.toLocaleLowerCase("en-US").replace(/\(optional\)/g, "")).label
    .replace(/\s+/g, " ").trim();
}

function contactValue(label: string, profile: PlannerInputs["profile"]): { key: ContactKey; value: string; label: string } | null {
  const whole = normalizedLabel(label);
  // Oracle's "First/Given Name (Please enter with letters a-z, …)": the instruction after the label is not part of it.
  const plain = whole.replace(/\s*\(please [^)]*\)\s*$/, "");
  // (Track 79) "LinkedIn Profile URL:": a trailing colon, question mark, or asterisk is not part of the label.
  const forms = [...new Set([whole, plain, ...[whole, plain].map((form) => form.replace(/[\s:?*]+$/, ""))])].filter(Boolean);
  for (const normalized of forms) {
    for (const { key, pattern } of CONTACT_LABELS) {
      if (!pattern.test(normalized)) continue;
      const value = contactField(key, profile)?.trim();
      if (!value) return null;
      // "State Abbreviation" takes the two-letter USPS code; a region that is no US state is not this field's answer.
      if (normalized === "state abbreviation") {
        const code = /^[a-z]{2}$/i.test(value) ? value : usStateAlternate(value);
        return code && /^[a-z]{2}$/i.test(code) && usStateAlternate(code) ? { key, value: code.toUpperCase(), label: normalized } : null;
      }
      return { key, value, label: normalized };
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
