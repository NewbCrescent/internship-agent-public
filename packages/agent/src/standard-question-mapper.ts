import { mentionsCompany, SAN_FRANCISCO, type CandidateFactKey, type FactScope, type QuestionContext, type QuestionMapping } from "@internship-agent/domain";

/**
 * Deterministic phrasings of the candidate's standard legal and background
 * questions (citizenship and export control, clearance, criminal history,
 * debarment, restrictive covenants, conflicts of interest, relatives in
 * government or health care, living within 50 miles of a place, Department
 * of Defense work, salary expectations). Returns null when no group matches,
 * so the mapper's later rules run. A question that combines several groups,
 * a negated statement, an open "describe" or "which" question asking for more
 * than a Yes/No, and a question broader or other than the saved fact all
 * hold (AMBIGUOUS). A question about a subset of a saved fact ("a felony" for
 * "a conviction") is flagged `narrower`: only a saved No answers it.
 */

const HEADING = /^[A-Z][A-Z0-9 &/,'’()-]{2,80}(?::|\s[-–—])\s+/;
const YES_NO_LEAD = /^(?:are|is|do|does|did|have|has|had|will|would|can|could|were|was|should)\b/;
const WH_LEAD = /^(?:what|which|when|how|where|who|list|describe|explain|please (?:describe|explain|list|provide))\b/;
const NEGATION = /\bnever\b|\bnot\b|n't\b|\bno longer\b/;
const EXPLAIN = /\bexplain\b|\bdescribe\b|\bdetails?\b|\belaborate\b|\bprovide (?:more )?information\b|\bif (?:yes|so)\b/;

const SALARY = /\bsalary\b|\bcompensation\b|\bpay\s+(?:expectations?|requirements?|range|rate)\b|\b(?:desired|expected|target|requested)\s+(?:pay|rate|wage|hourly rate|compensation|salary)\b|\bhourly\s+(?:rate|wage|pay)\b|\brate of pay\b|\bwage expectations?\b/;
const CITIZENSHIP = /\bcitizen(?:s|ship)?\b|\bpermanent resident\b|\bgreen card\b|\bu\.?\s?s\.? (?:person|national)\b|\bitar\b|\bear\b|\bexport[- ]control\w*|\bexport administration regulations\b|\binternational traffic in arms\b|\bdeemed exports?\b/;
// "You must be a U.S. Person because … Are you a US Person?": a Yes/No question asked after a statement.
const ASKS_US_PERSON = /(?:^|[.?!:;)]\s+)(?:are|is) you (?:a |an )?(?:u\.?\s?s\.?|us) person\b[^?]*\?/;
const CLEARANCE = /\bclearances?\b/;
const CLEARANCE_CONTEXT = /\bsecurity\b|\bsecret\b|\bts\b|\bsci\b|\bgovernment\b|\bfederal\b|\bdod\b|\bdepartment of defense\b|\bpublic trust\b|\b[ql] clearance\b/;
const CRIMINAL = /\bconvict\w*|\bfelon(?:y|ies)\b|\bmisdemeanou?rs?\b|\bcriminal\b|\bpled (?:guilty|no contest)\b|\bpleaded (?:guilty|no contest)\b|\barrest\w*|\bpending charges\b|\bcharged with\b/;
const DEBARMENT = /\bdebar\w*|\bexclu(?:ded|sion)\b[^.?]{0,80}\b(?:federal|government|health ?care|medicare|medicaid|programs?|lists?|contract\w*|procurement|oig|fda)\b|\bsuspended\b[^.?]{0,60}\b(?:federal|government|contract\w*|procurement)\b|\boig\b|\bsam\.gov\b|\bsanctioned\b/;
const NON_COMPETE = /\bnon[- ]?compet(?:e|es|ition)\b/;
const NON_SOLICIT = /\bnon[- ]?solicit(?:ation)?\b/;
const RESTRICTIVE = /\brestrictive covenants?\b/;
const OTHER_COVENANT = /\bnon[- ]?disclosure\b|\bconfidentiality\b|\bnda\b|\bintellectual property\b|\binvention assignment\b|\bno[- ]hire\b|\bnon[- ]?disparagement\b/;
const COI = /\bconflicts? of interest\b/;
const RELATIVE = /\brelatives?\b|\bfamily members?\b|\bimmediate family\b|\bhousehold members?\b|\brelated to\b|\bspouse\b/;
const GOVERNMENT = /\bgovernment\b|\bpublic officials?\b|\bforeign officials?\b|\bstate[- ]owned\b|\bfederal agency\b|\bpublic office\b/;
const HEALTH = /\bhealth ?care (?:professionals?|providers?|practitioners?|workers?)\b|\bphysicians?\b|\bdoctors?\b|\bnurses?\b|\bpharmacists?\b|\bprescribers?\b|\bclinicians?\b|\blicensed (?:health|medical)\b/;
const DISTANCE = /\bwithin\s+(\d{1,4}|fifty)\s*(?:-\s*)?(?:mi\b|miles?\b|mile radius)/;
const DOD = /\bdepartment of defense\b|\bdod\b|\bdefense (?:projects?|programs?|contracts?|work|customers?|industry|sector)\b/;
const EMPLOYER_REFERENCE = /\b(?:here|for us|with us|(?:this|our|the)\s+(?:company|organization|organisation|firm|employer))\b/;

type Prepared = {
  text: string;
  n: string;
  yesNo: boolean;
  wh: boolean;
  statement: boolean;
  textField: boolean;
  choiceField: boolean;
  usWords: boolean;
  context: QuestionContext;
};

const ambiguous = (reason: string): QuestionMapping => ({ status: "AMBIGUOUS", reason });

function mapped(key: CandidateFactKey, explanation: string, options: { scope?: FactScope; narrower?: boolean } = {}): QuestionMapping {
  return {
    status: "MAPPED",
    key,
    scope: options.scope ?? { kind: "global" },
    confidence: 0.9,
    method: "deterministic",
    explanation,
    ...(options.narrower ? { narrower: true } : {})
  };
}

/** A Yes/No fact: an open "what/which/describe" question, or a text box asking for details without a Yes/No lead, holds. */
function yesNo(
  question: Prepared,
  key: CandidateFactKey,
  explanation: string,
  options: { scope?: FactScope; narrower?: boolean; allowWh?: boolean } = {}
): QuestionMapping {
  if ((!options.allowWh && question.wh) || (question.textField && EXPLAIN.test(question.n) && !question.yesNo)) {
    return ambiguous("The question asks for more than a saved Yes or No; answer it directly.");
  }
  return mapped(key, explanation, options);
}

export function mapStandardQuestion(question: string, context: QuestionContext): QuestionMapping | null {
  const text = question.trim().replace(HEADING, "");
  const n = text.replace(/’/g, "'").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim().replace(/\s*\*$/, "");
  const yesNoLead = YES_NO_LEAD.test(n);
  const whLead = WH_LEAD.test(n);
  const prepared: Prepared = {
    text,
    n,
    yesNo: yesNoLead,
    wh: whLead,
    statement: !text.includes("?") && !yesNoLead && !whLead,
    textField: context.fieldKind === "text" || context.fieldKind === "textarea",
    choiceField: context.fieldKind === "select" || context.fieldKind === "radio",
    usWords: /\bu\.\s?s\.?(?:\s?a\.?)?(?![a-z])|\bunited states\b|\bamerica(?:n)?\b|\busa\b/i.test(text) || /\bUS\b/.test(text) ||
      context.postingCountryCode?.toUpperCase() === "US",
    context
  };

  const covenant = NON_COMPETE.test(n) || NON_SOLICIT.test(n) || RESTRICTIVE.test(n) || OTHER_COVENANT.test(n);
  const clearance = CLEARANCE.test(n) && CLEARANCE_CONTEXT.test(n);
  const groups = {
    salary: SALARY.test(n),
    citizenship: CITIZENSHIP.test(n),
    clearance,
    criminal: CRIMINAL.test(n),
    debarment: DEBARMENT.test(n),
    covenant,
    coi: COI.test(n),
    relativeGov: RELATIVE.test(n) && GOVERNMENT.test(n),
    familyHealth: RELATIVE.test(n) && HEALTH.test(n),
    distance: DISTANCE.test(n),
    dod: DOD.test(n) && !clearance
  };
  const matched = (Object.keys(groups) as Array<keyof typeof groups>).filter((group) => groups[group]);
  if (matched.length === 0) return null;
  if (matched.length > 1) return ambiguous("The question combines several saved legal or background answers; answer it directly.");
  if (prepared.statement && NEGATION.test(n)) return ambiguous("A negated statement is answered directly.");

  switch (matched[0]!) {
    case "salary": return salary(prepared);
    case "citizenship": return citizenship(prepared);
    case "clearance": return clearanceQuestion(prepared);
    case "criminal": return criminal(prepared);
    case "debarment":
      return yesNo(prepared, "government_debarment_or_exclusion", "Government debarment or exclusion question.", {
        narrower: /\bfda\b|\boig\b|\bhhs\b|\bmedicare\b|\bmedicaid\b|\bhealth ?care\b|\bsam\.gov\b|\bgsa\b|\bdepartment of\b|\bfood and drug\b|\binspector general\b|\bsanction\w*/.test(n)
      });
    case "covenant": return covenantQuestion(prepared);
    case "coi": return yesNo(prepared, "conflict_of_interest", "Conflict-of-interest question.");
    case "relativeGov": return relativeGovernment(prepared);
    case "familyHealth": return familyHealth(prepared);
    case "distance": return distance(prepared);
    case "dod": return dod(prepared);
  }
}

// "Are you comfortable with the advertised salary range?" asked as a list: the salary rule (the posting's stated pay) agrees.
const RANGE_COMFORT = /\b(?:comfortable|okay|ok|fine|agree|accept(?:able)?|align\w*|happy)\b[^?]{0,60}\b(?:advertised|posted|listed|stated|published|displayed)\b[^?]{0,20}\b(?:range|rate|salary|pay|compensation|wage)\b|\b(?:advertised|posted|listed|stated|published)\s+(?:salary |pay |compensation |hourly )?(?:range|rate)\b[^?]{0,40}\b(?:comfortable|okay|acceptable|agree|align\w*)\b/;

function salary(question: Prepared): QuestionMapping {
  const { n } = question;
  if (question.choiceField && RANGE_COMFORT.test(n)) {
    return mapped("salary_expectation_rule", "Comfortable with the posting's advertised pay range; your salary rule is the posting's stated pay.");
  }
  if (/\b(?:current|previous|prior|last|past|most recent|present)\s+(?:base\s+)?(?:salary|pay|compensation|wage|hourly rate|rate)\b|\bsalary history\b|\bcompensation history\b/.test(n) ||
    /\bminimum\b|\blowest\b/.test(n) ||
    (question.yesNo && /\b(?:comfortable|acceptable|okay|ok|agree|accept|aligns?|fine|willing|meet)\b/.test(n))) {
    return ambiguous("The question asks about pay other than the candidate's expectation; answer it directly.");
  }
  return mapped("salary_expectation", "Salary or pay expectation question; answered from the posting's stated pay.");
}

function citizenship(question: Prepared): QuestionMapping {
  const { n } = question;
  if (/\b(?:dual|other|another|any other|foreign)\s+(?:\w+\s+)?citizen/.test(n) || /\bcitizen(?:ship)? of (?!the united states|the u\.?s\.?|america)/.test(n)) {
    return ambiguous("The question asks about a citizenship other than U.S. citizenship; answer it directly.");
  }
  const exportWords = /\bu\.?\s?s\.? person\b|\bitar\b|\bear\b|\bexport\b|\binternational traffic in arms\b|\bdeemed exports?\b/.test(n);
  const listWords = /\b(?:which|what|select|indicate|choose|identify)\b[^?]{0,80}\b(?:describes|applies|apply|status|category|categories|following)\b/.test(n);
  if (exportWords) {
    if (listWords) return mapped("us_person_export_controls", "Export-control status list (U.S. person under ITAR/EAR).");
    if (question.yesNo || ASKS_US_PERSON.test(n) || /^(?:i am|i'm)\b/.test(n)) return yesNo(question, "us_person", "U.S. person (ITAR/EAR) question.");
    if (question.choiceField) return mapped("us_person_export_controls", "Export-control status choice (U.S. person under ITAR/EAR).");
    return ambiguous("The export-control statement does not ask a question the saved status answers; answer it directly.");
  }
  if (!question.usWords) return ambiguous("Citizenship questions are answered only for the United States, and the question names no country.");
  const lpr = /\bpermanent resident\b|\bgreen card\b/.test(n);
  const refugeeEtc = /\brefugee\b|\basyl(?:ee|um)\b|\bprotected individual\b/.test(n);
  const national = /\bnational\b/.test(n);
  const citizen = /\bcitizen(?:s|ship)?\b/.test(n);
  if (citizen && lpr && refugeeEtc) return yesNo(question, "us_person", "U.S. citizen, permanent resident, refugee, or asylee question.");
  if (refugeeEtc) return ambiguous("The question lists only some U.S. person categories; answer it directly.");
  if (citizen && lpr) {
    if (national) return ambiguous("The question mixes citizenship, nationality, and permanent residence; answer it directly.");
    return yesNo(question, "us_citizen_or_permanent_resident", "U.S. citizen or permanent resident question.");
  }
  if (citizen && national) return yesNo(question, "us_citizen_or_national", "U.S. citizen or national question.");
  if (citizen) {
    if (listWords || /\bcitizenship status\b/.test(n)) {
      return question.choiceField
        ? mapped("us_citizen", "U.S. citizenship status choice.")
        : ambiguous("A citizenship status text box is answered directly.");
    }
    return yesNo(question, "us_citizen", "U.S. citizenship question.");
  }
  return ambiguous("The question asks about U.S. residence status other than citizenship; answer it directly.");
}

function clearanceQuestion(question: Prepared): QuestionMapping {
  const { n } = question;
  const eligible = /\beligib\w*|\bable to (?:obtain|get|acquire|receive)\b|\bobtain\b|\bqualify\b|\bqualified to (?:obtain|receive)\b/.test(n);
  const holds = /\b(?:hold|holds|have|has|possess|possesses)\b|\bactive\b|\bcurrent(?:ly)?\b|\bexisting\b/.test(n);
  const strongHolds = /\bcurrently (?:hold|have|possess)\b|\b(?:hold|possess)(?:es)? (?:an?|any)\b|\bactive (?:\w+ )?clearance\b|\bcurrent (?:\w+ )?clearance\b|\bexisting (?:\w+ )?clearance\b/.test(n);
  if (/\b(?:ever|previously|past|expired|inactive|lapsed)\b/.test(n) || (/\b(?:willing|interested)\b/.test(n) && !eligible) || (eligible && strongHolds)) {
    return ambiguous("The clearance question asks about more than an active clearance or eligibility; answer it directly.");
  }
  if (eligible) return yesNo(question, "security_clearance_eligible", "Security-clearance eligibility question.");
  if (holds) return yesNo(question, "holds_security_clearance", "Active security-clearance question.");
  return ambiguous("The clearance question does not ask whether a clearance is held or obtainable; answer it directly.");
}

function criminal(question: Prepared): QuestionMapping {
  const { n } = question;
  if (/\barrest\w*|\bpending\b|\bcharged\b|\bindict\w*|\bunder investigation\b|\bdeferred\b|\bdiversion\b|\bprobation\b|\bparole\b/.test(n) ||
    !/\bconvict\w*|\bpled\b|\bpleaded\b|\bguilty\b/.test(n) ||
    (/\btraffic\b/.test(n) && !/\bexclud\w*|\bother than\b|\bexcept\b/.test(n))) {
    return ambiguous("The criminal-history question asks about more than convictions; answer it directly.");
  }
  return yesNo(question, "criminal_conviction", "Criminal conviction question.", {
    narrower: /\bfelon(?:y|ies)\b|\bmisdemeanou?rs?\b|\b(?:last|past)\s+(?:\d+|\w+)\s+years?\b|\bviolent\b|\bfraud\b|\btheft\b|\bdu[iw]\b|\bdrug\b/.test(n)
  });
}

function covenantQuestion(question: Prepared): QuestionMapping {
  const { n } = question;
  const nc = NON_COMPETE.test(n);
  const ns = NON_SOLICIT.test(n);
  if (OTHER_COVENANT.test(n) || (RESTRICTIVE.test(n) && !(nc && ns)) || /\bwhen\b|\bdate\b|\bexpir\w*|\bends?\b|\bended\b|\bhow long\b|\bduration\b/.test(n)) {
    return ambiguous("The question asks about an agreement or detail the saved answers do not cover; answer it directly.");
  }
  const restrict = /\b(?:restrict|prevent|prohibit|limit|preclude|bar|impact|affect|impair|interfere)\w*\b/.test(n) &&
    /\b(?:job|role|position|work|working|duties|employment|ability|perform\w*)\b/.test(n);
  if (restrict) {
    if (ns && !nc) return yesNo(question, "non_solicitation_restricts_this_job", "Whether the non-solicitation agreement restricts this role.");
    if (nc && !ns) return yesNo(question, "non_compete", "Whether a non-compete agreement restricts this role.", { narrower: true });
    return ambiguous("The question asks whether several agreements restrict this role; answer it directly.");
  }
  if (ns && !nc) {
    const explain = EXPLAIN.test(n) && (question.textField || (question.context.fieldKind === undefined && !question.yesNo));
    if (explain) return mapped("non_solicitation_explanation", "Non-solicitation agreement explanation.");
    return yesNo(question, "non_solicitation", "Non-solicitation agreement question.");
  }
  if (nc && ns) {
    if (EXPLAIN.test(n) && question.textField) return ambiguous("The question asks to explain several agreements; answer it directly.");
    return yesNo(question, "non_compete_or_non_solicitation", "Non-compete or non-solicitation agreement question.");
  }
  return yesNo(question, "non_compete", "Non-compete agreement question.");
}

function namesEmployer(question: Prepared): boolean {
  return EMPLOYER_REFERENCE.test(question.n) ||
    Boolean(question.context.companyName && mentionsCompany(question.text, question.context.companyName));
}

function relativeGovernment(question: Prepared): QuestionMapping {
  const { n } = question;
  if (/\bassociates?\b|\bfriends?\b|\bbusiness partners?\b/.test(n) || namesEmployer(question)) {
    return ambiguous("The question asks about more than relatives in government; answer it directly.");
  }
  return yesNo(question, "relative_government_official", "Relatives who are government officials question.", {
    narrower: /\bforeign\b|\bstate[- ]owned\b|\bimmediate family\b|\bspouse\b|\bhousehold\b/.test(n)
  });
}

function familyHealth(question: Prepared): QuestionMapping {
  const { n } = question;
  if (!/\bimmediate family\b|\bhousehold\b|\bspouse\b|\bparents?\b|\bsiblings?\b|\bchildren\b/.test(n)) {
    return ambiguous("The question asks about relatives beyond immediate family; answer it directly.");
  }
  // A label naming the employer only as a buyer or user of its products stays mapped (narrower).
  if (namesEmployer(question) && !/\bproducts?\b|\bcustomers?\b|\buse\b|\bpurchas\w*/.test(n)) {
    return ambiguous("The question asks about family at this employer; answer it directly.");
  }
  return yesNo(question, "immediate_family_health_care_professional", "Immediate family members who are health care professionals question.", {
    narrower: /\bspouse\b|\bparents?\b|\bsiblings?\b|\bchildren\b|\bprescrib\w*|\bpurchas\w*|\bproducts?\b|\bcustomers?\b|\brefer\w*|\bpractic\w*/.test(n)
  });
}

const SAN_FRANCISCO_PLACE = /^(?:the\s+)?(?:city of\s+)?(?:san francisco|sf)(?:\s*,?\s*(?:ca|california))?(?:\s*,?\s*(?:usa|us|united states))?$/i;

function distance(question: Prepared): QuestionMapping {
  const { n } = question;
  const radius = DISTANCE.exec(n)?.[1];
  if (radius !== "50" && radius !== "fifty") return ambiguous("Only a 50-mile distance answer is saved; answer it directly.");
  if (!/\b(?:live|lives|living|reside|resides|residing|located|based|home)\b|\bare you (?:currently )?within\b/.test(n)) {
    return ambiguous("The distance question does not ask where the candidate lives; answer it directly.");
  }
  const captured = /\bwithin\s+(?:50|fifty)\s*(?:-\s*)?(?:mi|miles?|mile radius)\s+(?:of|from)\s+(.+?)\s*(?:[?.!;(]|$)/i.exec(question.text)?.[1] ?? "";
  const place = captured.trim()
    .replace(/^(?:our|the|your)\s+/i, "")
    .replace(/\s+(?:offices?|hq|headquarters|campus|location)$/i, "")
    .replace(/,$/, "")
    .trim();
  if (SAN_FRANCISCO_PLACE.test(place)) {
    return yesNo(question, "lives_within_50_miles", "Lives within 50 miles of San Francisco question.", { scope: { kind: "location", name: SAN_FRANCISCO } });
  }
  if (place.length < 2 || place.length > 120 || /\b(?:office|this|our)\b/i.test(place)) {
    return ambiguous("The distance question names no place the saved answer can be scoped to; answer it directly.");
  }
  return yesNo(question, "lives_within_50_miles", `Lives within 50 miles of ${place} question.`, { scope: { kind: "location", name: place } });
}

function dod(question: Prepared): QuestionMapping {
  if (!/\bconcerns?\b|\breservations?\b|\bobjections?\b|\bobject to\b|\bopposed\b/.test(question.n)) {
    return ambiguous("Only concerns about Department of Defense work are saved; answer this one directly.");
  }
  return yesNo(question, "concerns_working_on_dod_projects", "Concerns about working on Department of Defense projects question.");
}
