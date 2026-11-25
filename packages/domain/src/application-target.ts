import type { JobCompensation } from "./job-posting";
import type { SemanticFitAssessment } from "./matching";
import { AUTO_SUBMIT_MIN_FIT_FLOOR } from "./submission-mode";

/**
 * Which postings the automatic pipeline pursues for the candidate's stated
 * target (INTERNSHIP_AGENT_TARGET_TERM, for example summer-2027): the right
 * term, a software or adjacent role, a US location, not stated as unpaid, and a current AI
 * judgment at or above the candidate's bar. Every step reads only stated
 * text; silence is never a pass for the location and AI steps, so an unknown
 * sends the posting to the candidate instead of out the door.
 *
 *   apply  — may be submitted automatically when the run itself is clean
 *   review — prepared and filled, then left for the candidate
 *   skip   — not pursued
 */
export type TargetOutcome = "apply" | "review" | "skip";
export type TargetDecision = { outcome: TargetOutcome; reasons: string[] };
export type TargetTerm = { season: "summer" | "fall" | "winter" | "spring"; year: number };

export function parseTargetTerm(raw: string | undefined): TargetTerm | null {
  const match = /^(summer|fall|winter|spring)-(20\d\d)$/i.exec(raw?.trim() ?? "");
  return match ? { season: match[1]!.toLocaleLowerCase("en-US") as TargetTerm["season"], year: Number.parseInt(match[2]!, 10) } : null;
}

export type TargetPosting = {
  title: string;
  text: string;
  employmentType: "INTERNSHIP" | "CO_OP" | "NEW_GRAD" | "OTHER";
  countryCodes: string[];
  /** The posting lives on Handshake or applies through it (the caller classifies its URLs). */
  onHandshake: boolean;
  /** The extracted pay, when one was found; absent or null means the posting is silent on pay. */
  compensation?: Pick<JobCompensation, "minimum" | "maximum" | "period"> | null;
};

const RANK: Record<TargetOutcome, number> = { apply: 0, review: 1, skip: 2 };

/** The strictest outcome wins; every reason is kept. */
export function combineTargetDecisions(...decisions: TargetDecision[]): TargetDecision {
  return decisions.reduce<TargetDecision>((worst, next) => ({
    outcome: RANK[next.outcome] > RANK[worst.outcome] ? next.outcome : worst.outcome,
    reasons: [...worst.reasons, ...next.reasons]
  }), { outcome: "apply", reasons: [] });
}

const SEASONS = ["summer", "fall", "autumn", "winter", "spring"] as const;
const OFF_CYCLE_MONTH = /\b(?:january|february|march|april|september|october|november|december|jan|feb|sept?|oct|nov|dec)\b/i;
const LONG_TERM = /\b(?:(?:4|5|6|7|8|9|10|11|12)\s*[- ]?\s*(?:months?|mos?)\b|(?:four|five|six|seven|eight|nine|ten|eleven|twelve)[- ]months?\b|placement year|year[- ]in[- ]industry|industrial placement|sandwich (?:year|placement))/i;
const CO_OP = /\bco-?op\b/i;

/** The internship's term, read from the title first and the text second. */
export function judgeTerm(posting: Pick<TargetPosting, "title" | "text" | "employmentType">, term: TargetTerm): TargetDecision {
  const title = posting.title.toLocaleLowerCase("en-US");
  const wanted = term.season;
  const year = String(term.year);
  const seasonYears = [...title.matchAll(/\b(summer|fall|autumn|winter|spring)\s*'?\s*(20\d\d|\d\d)\b/g)]
    .map((match) => ({ season: match[1] === "autumn" ? "fall" : match[1]!, year: match[2]!.length === 2 ? "20" + match[2] : match[2]! }));
  const titleNamesWanted = new RegExp(`\\b${wanted}\\b`).test(title);
  if (seasonYears.some((entry) => entry.season === wanted && entry.year !== year) && !seasonYears.some((entry) => entry.season === wanted && entry.year === year)) {
    return { outcome: "skip", reasons: [`Term: the title names ${wanted} of another year, not ${wanted} ${year}.`] };
  }
  if (LONG_TERM.test(posting.title)) return { outcome: "skip", reasons: [`Term: the title names a longer placement than one ${wanted}.`] };
  if (titleNamesWanted) {
    // "Spring/Summer 2027" or a summer co-op may still mean a longer or earlier term.
    const alsoOther = SEASONS.some((season) => season !== wanted && new RegExp(`\\b${season}\\b`).test(title));
    return alsoOther || CO_OP.test(posting.title)
      ? { outcome: "review", reasons: [`Term: the title names ${wanted} with another term or a co-op.`] }
      : { outcome: "apply", reasons: [] };
  }
  if (/\bh[12]\s*'?\s*20\d\d\b/.test(title)) return { outcome: "skip", reasons: ["Term: the title names a half-year term."] };
  const otherSeason = SEASONS.filter((season) => season !== wanted && !(wanted === "fall" && season === "autumn"))
    .find((season) => new RegExp(`\\b${season}\\b`).test(title));
  if (otherSeason) return { outcome: "skip", reasons: [`Term: the title names ${otherSeason}, not ${wanted}.`] };
  if (OFF_CYCLE_MONTH.test(posting.title) && /\b20\d\d\b/.test(posting.title)) {
    return { outcome: "skip", reasons: [`Term: the title names an off-cycle start month, not ${wanted}.`] };
  }
  if (CO_OP.test(posting.title) || posting.employmentType === "CO_OP") {
    return { outcome: "skip", reasons: [`Term: a co-op without ${wanted} in the title is usually a semester-long term.`] };
  }
  const text = posting.text;
  const textNamesWanted = new RegExp(`\\b${wanted}\\b`, "i").test(text);
  const textOffCycle = new RegExp(String.raw`\b(?:fall|autumn|winter|spring)\s+(?:semester|term|quarter|20\d\d|co-?op)\b|\b(?:january|february|march|april|september|october)\s+(?:20\d\d|start)\b|\bco-?op\s+(?:term|semester|rotation)\b`, "i").test(text);
  if (LONG_TERM.test(text) && !textNamesWanted) return { outcome: "skip", reasons: ["Term: the description names a placement longer than one summer."] };
  if (textOffCycle && !textNamesWanted) return { outcome: "skip", reasons: [`Term: the description names an off-cycle term and never ${wanted}.`] };
  if (textOffCycle && textNamesWanted) return { outcome: "review", reasons: [`Term: the description names both ${wanted} and another term.`] };
  return { outcome: "apply", reasons: [] };
}

const SOFTWARE = /\b(?:software|swe|sde|developer|programmer|programming|full[\s-]?stack|back[\s-]?end|front[\s-]?end|web|mobile|ios|android|platform|devops|sre|site reliability|infrastructure|cloud|distributed systems|data engineer(?:ing)?|machine learning|ml|ai|artificial intelligence|deep learning|llm|genai|generative ai|computer vision|nlp|data scientist|data science|security engineer(?:ing)?|application security|automation engineer|test engineer|sdet|qa engineer|computer science|engineering intern(?:ship)?|technology intern(?:ship)?|tech intern(?:ship)?|forward deployed|member of technical staff|technical staff)\b/i;
const NOT_SOFTWARE = /\b(?:ph\.?\s?d|doctoral|master'?s|mba|sales|marketing|recruit(?:ing|er)?|human resources|people operations|accounting|tax|audit|legal|paralegal|procurement|sourcing|supply chain|mechanical|electrical|civil|chemical|manufacturing|hardware|analog|rf|asic|fpga|pcb|silicon|product manager|product management|program manager|project manager|designer|ux|graphic|copywriter|communications|policy|actuarial|underwriting|trading|trader|quantitative research(?:er)?|research scientist|investment banking|wealth management|clinical|nursing|pharmacy|technician|customer success|business analyst|financial analyst|business operations|business development|strategy|content|administration|administrator)\b/i;
const ANALYST_ONLY = /\banaly(?:st|tics)\b/i;
const ANALYST_ENGINEERING = /\b(?:engineer(?:ing)?|developer|software|scientist)\b/i;

/** Software engineering or adjacent (ML/AI, data, infrastructure, security engineering), from the title. */
export function judgeRole(title: string): TargetDecision {
  const excluded = NOT_SOFTWARE.exec(title);
  if (excluded) return { outcome: "skip", reasons: [`Role: "${excluded[0]}" in the title is outside software engineering and adjacent roles.`] };
  if (ANALYST_ONLY.test(title) && !ANALYST_ENGINEERING.test(title)) {
    return { outcome: "skip", reasons: ["Role: an analyst role is not software engineering or adjacent."] };
  }
  if (!SOFTWARE.test(title)) return { outcome: "skip", reasons: ["Role: the title names no software or adjacent engineering work."] };
  return { outcome: "apply", reasons: [] };
}

/** A stated US location passes; another country skips; no stated country goes to the candidate. */
export function judgeLocation(countryCodes: string[]): TargetDecision {
  if (countryCodes.includes("US")) return { outcome: "apply", reasons: [] };
  if (countryCodes.length > 0) return { outcome: "skip", reasons: [`Location: ${[...new Set(countryCodes)].join(", ")}, not the United States.`] };
  return { outcome: "review", reasons: ["Location: no country is stated, so it is not sent automatically."] };
}

/** The automatic pipeline's scope is the GitHub internship lists; Handshake postings are left to the candidate. */
export function judgeSource(onHandshake: boolean): TargetDecision {
  return onHandshake
    ? { outcome: "skip", reasons: ["Source: Handshake is out of scope (GitHub lists only)."] }
    : { outcome: "apply", reasons: [] };
}

// Only explicit statements count; a posting silent on pay, or one naming pay, a
// stipend, or an hourly rate, is never read as unpaid. "Paid or unpaid
// internship", "not an unpaid internship", and "we never offer unpaid
// internships" (a plural is about internships in general) are not statements
// that this one is.
const NOT_THIS_ONE = String.raw`(?<!\bpaid\s*(?:or|and|\/)\s*)(?<!\b(?:not|never)\s+(?:an?\s+)?)`;
const UNPAID_STATEMENTS = [
  /[([]\s*unpaid\s*[)\]]/i,
  new RegExp(NOT_THIS_ONE + String.raw`\bunpaid\s+(?:(?:summer|part[- ]time|full[- ]time|remote|virtual)\s+)?(?:intern(?:ship)?|position|role|opportunity|placement|program|externship|fellowship)\b`, "i"),
  /\b(?:intern(?:ship)?|position|role|opportunity|placement|program)\s+(?:is|will be)\s+(?:an?\s+)?unpaid\b/i,
  // "No compensation will be provided", not "no compensation for travel" or "no compensation decisions".
  /\bno\s+(?:monetary\s+|financial\s+)?compensation\b(?!\s+(?:(?:for|of)\s+(?:travel|relocation|housing|expenses?|mileage|parking|commuting|overtime|meals?)|decisions?|discrimination|history|data|information|structure|philosophy|questions?)\b)/i,
  /\b(?:this|it)\s+(?:is|will be)\s+an?\s+(?:unpaid\s+)?volunteer\s+(?:position|role|internship|opportunity)\b/i
];
// In a title, "unpaid" alone ("Internship - Unpaid") or "(Volunteer)" also
// counts, unless "unpaid" names something other than the internship ("Unpaid Invoices").
const UNPAID_TITLE = [
  new RegExp(NOT_THIS_ONE + String.raw`\bunpaid\b(?!\s+(?:invoices?|balances?|bills?|claims?|leave|accounts?|debts?|wages?|taxes|time)\b)`, "i"),
  /[([]\s*volunteer\s*[)\]]/i
];

function statesUnpaid(text: string): boolean {
  return UNPAID_STATEMENTS.some((pattern) => pattern.test(text));
}

/**
 * Unpaid internships are not pursued (the candidate's rule, 2026-11-24:
 * "unpaid inter ships should be ruled out"). A title or description that
 * states the internship is unpaid, or an extracted pay of exactly zero, skips;
 * a description that says unpaid while a positive figure was extracted goes to
 * the candidate. Silence on pay passes.
 */
export function judgePay(posting: Pick<TargetPosting, "title" | "text" | "compensation">): TargetDecision {
  const pay = posting.compensation ?? null;
  const figures = pay ? [pay.minimum, pay.maximum].filter((value): value is number => value !== null) : [];
  if (figures.length > 0 && figures.every((value) => value === 0)) {
    return { outcome: "skip", reasons: ["Pay: the posting states zero pay."] };
  }
  if (UNPAID_TITLE.some((pattern) => pattern.test(posting.title)) || statesUnpaid(posting.title)) {
    return { outcome: "skip", reasons: ["Pay: the posting says the internship is unpaid."] };
  }
  if (statesUnpaid(posting.text)) {
    return figures.some((value) => value > 0)
      ? { outcome: "review", reasons: ["Pay: the description calls the internship unpaid but also states pay."] }
      : { outcome: "skip", reasons: ["Pay: the posting says the internship is unpaid."] };
  }
  return { outcome: "apply", reasons: [] };
}

/** The cheap, text-only steps; they run before any model call. */
export function judgeTargetPosting(posting: TargetPosting, term: TargetTerm): TargetDecision {
  return combineTargetDecisions(
    judgeSource(posting.onHandshake), judgeTerm(posting, term), judgeRole(posting.title), judgeLocation(posting.countryCodes), judgePay(posting)
  );
}

const LEVEL_GAP = /\b(?:master'?s|ph\.?\s?d|doctoral|doctorate|graduate (?:student|degree|program|level)|mba|post-?graduate|class standing|year of study)\b/i;
/**
 * Below this AI score a posting is not pursued, unless the candidate set a
 * lower auto-submit bar (never below 40).
 */
export const WEAK_FIT_BELOW = 50;

/** The score below which a posting is skipped for a given auto-submit bar. */
export function fitSkipLine(minFit: number): number {
  return Math.max(AUTO_SUBMIT_MIN_FIT_FLOOR, Math.min(WEAK_FIT_BELOW, minFit));
}

/**
 * The AI's current judgment (null when it is missing or out of date; the
 * keyword estimate never stands in for it). A MODERATE or STRONG current
 * judgment at or above the bar may be submitted; INSUFFICIENT_INFORMATION,
 * LOW confidence, a degree-level gap, or a score below the bar go to review,
 * and a score below the skip line is not pursued.
 */
export function judgeFit(assessment: SemanticFitAssessment | null, minFit: number): TargetDecision {
  if (!assessment || assessment.version !== 2) return { outcome: "review", reasons: ["Fit: no current AI judgment."] };
  if (assessment.rating === "INSUFFICIENT_INFORMATION") return { outcome: "review", reasons: ["Fit: the AI had too little to judge."] };
  const skipBelow = fitSkipLine(minFit);
  if (assessment.score < skipBelow) {
    return { outcome: "skip", reasons: [`Fit: AI score ${assessment.score} (${assessment.rating.toLocaleLowerCase("en-US")}) is below the skip line of ${skipBelow}.`] };
  }
  const reasons: string[] = [];
  if (assessment.score < minFit) reasons.push(`Fit: AI score ${assessment.score} is below ${minFit}.`);
  if (assessment.rating === "WEAK") reasons.push("Fit: rated weak.");
  if (assessment.confidence === "LOW") reasons.push("Fit: the AI's confidence is low.");
  const levelGap = assessment.gaps.find((gap) => LEVEL_GAP.test(gap.text) || LEVEL_GAP.test(gap.postingQuote));
  if (levelGap) reasons.push(`Fit: the AI noted a degree-level gap: ${levelGap.text.slice(0, 200)}`);
  return { outcome: reasons.length ? "review" : "apply", reasons };
}
