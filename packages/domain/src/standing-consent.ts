import { manualOnly } from "./submission-mode";

/**
 * Standing consent and attestations: two explicit candidate settings
 * (2026-11-20) that let the agent accept or sign application statements whose
 * truth does not depend on an unknown candidate fact.
 *
 * - INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT=1 accepts data-processing,
 *   data-retention, and privacy-policy consent that is a condition of applying,
 *   and a site's terms and conditions or terms of use accepted as a condition
 *   of applying (the candidate's decision, 2026-11-24).
 * - INTERNSHIP_AGENT_SIGN_ATTESTATIONS=1 signs accuracy certifications,
 *   electronic signatures, acknowledgments (at-will, privacy or applicant
 *   notice, temporary internship, equal-opportunity statement), and
 *   background-check, drug-test, reference-check, and arbitration
 *   authorizations (including a notice that the process will require a
 *   background check or drug screen, acknowledged).
 *
 * The classifier is a deterministic whitelist. Statements of fact about the
 * candidate (citizenship, export control, clearance, debarment, criminal
 * history, prior employment, relatives and immediate family, where they live,
 * …) and marketing opt-ins are checked first and veto acceptance; a label
 * recognition clipped ("…") is never accepted. A vetoed statement is left to
 * the usual rules, where only the candidate's saved facts can answer it.
 * Manual checklist mode turns both settings off.
 */
export type StandingConsentSettings = { acceptDataConsent: boolean; signAttestations: boolean };

export function standingConsentSettings(env: Record<string, string | undefined> = process.env): StandingConsentSettings {
  if (manualOnly(env)) return { acceptDataConsent: false, signAttestations: false };
  return {
    acceptDataConsent: env.INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT?.trim() === "1",
    signAttestations: env.INTERNSHIP_AGENT_SIGN_ATTESTATIONS?.trim() === "1"
  };
}

export type StandingGroup =
  | "data-retention"
  | "data-processing"
  | "privacy-policy"
  | "terms-of-use"
  | "accuracy-certification"
  | "acknowledgment"
  | "authorization";

export const DATA_CONSENT_GROUPS: ReadonlySet<StandingGroup> = new Set<StandingGroup>(["data-retention", "data-processing", "privacy-policy", "terms-of-use"]);
export const ATTESTATION_GROUPS: ReadonlySet<StandingGroup> = new Set<StandingGroup>(["accuracy-certification", "acknowledgment", "authorization"]);

/** The setting a `standing_consent` basis records. */
export type StandingBasisSetting = "accept_data_consent" | "sign_attestations" | "both";

/** The kinds of fact statement that veto acceptance (`factGroupsOf`). */
export type FactGroup =
  | "citizenship-export"
  | "government-clearance"
  | "debarment"
  | "conflict-of-interest"
  | "criminal-history"
  | "prior-employment"
  | "non-compete"
  | "relatives"
  | "residence"
  | "work-authorization"
  | "age"
  | "enrollment"
  | "demographic"
  | "first-person-fact";

/** Statements of fact about the candidate: never accepted, whatever the settings. */
const FACT_GROUPS: ReadonlyArray<{ group: FactGroup; pattern: RegExp }> = [
  // Citizenship, U.S. person, export control.
  {
    group: "citizenship-export",
    pattern:
      /\bu\.?s\.? (?:citizen|person|national)s?\b|\bcitizen(?:ship)?\b|\bpermanent resident\b|\bgreen card\b|\bexport[- ]control\w*|\bitar\b|\bdeemed export|\bexport administration regulations\b/i
  },
  // Government, DoD, clearance.
  {
    group: "government-clearance",
    pattern: /\bdepartment of defense\b|\bdod\b|\bgovernment (?:employee|official|eligibility)\b|\bfederal employee\b|\b(?:security )?clearance\b/i
  },
  // Debarment and exclusion.
  { group: "debarment", pattern: /\bdebar\w*|\bexclusion list\b|\bexcluded from\b|\boig\b|\bfda\b|\bsanction(?:ed|s)?\b/i },
  // Conflict of interest.
  { group: "conflict-of-interest", pattern: /\bconflicts? of interest\b/i },
  // A criminal-history assertion (an authorization that merely mentions "criminal history" is not one).
  {
    group: "criminal-history",
    pattern:
      /\b(?:i have (?:never|not) been|have you (?:ever )?been|i am not|i have no)\b[^.]{0,40}\b(?:convicted|charged|arrested|criminal)\b|\bfelon(?:y|ies)\b|\bmisdemeanou?rs?\b|\bpending (?:criminal )?charges\b/i
  },
  // Prior employment.
  {
    group: "prior-employment",
    pattern: /\b(?:previously|formerly|ever|before) (?:been )?(?:worked|employed|interned)\b|\bformer (?:employee|intern|contractor)\b|\bcurrent or former\b/i
  },
  // Non-compete and restrictive covenants.
  { group: "non-compete", pattern: /\bnon[- ]?(?:compete|competition|solicitation|disclosure)\b|\brestrictive covenants?\b/i },
  // Relatives and immediate family (at the company, in government, in health care).
  { group: "relatives", pattern: /\brelatives?\b|\bfamily members?\b|\b(?:am|is|are) related to\b|\bimmediate family\b/i },
  // Where the candidate lives ("I live within 50 miles of …").
  {
    group: "residence",
    pattern: /\b(?:live|lives|living|reside|resides|residing|located|based)\b[^.]{0,40}\bwithin\s+(?:\d+|fifty)\s*(?:-\s*)?mi(?:les?)?\b|\bwithin\s+(?:\d+|fifty)\s*(?:-\s*)?miles?\s+(?:of|from)\b/i
  },
  // Work authorization and visas.
  {
    group: "work-authorization",
    pattern: /\bauthori[sz]ed to work\b|\bwork authori[sz]ation\b|\beligible to work\b|\blegally (?:able|authori[sz]ed|permitted) to work\b|\bsponsor\w*|\bvisa\b/i
  },
  // Age.
  { group: "age", pattern: /\b(?:at least|over|under) (?:18|eighteen|21)\b|\b\d{2} years of age\b|\b(?:18|eighteen) (?:years (?:of age )?)?or older\b/i },
  // Enrolment and degree.
  { group: "enrollment", pattern: /\bcurrently enrolled\b|\benrolled (?:full|part)[- ]time\b|\bgpa\b|\bgraduat\w*|\bdegree\b/i },
  // Demographic self-identification ("I identify as…", "I am a veteran/female/…", "my gender/race…").
  {
    group: "demographic",
    pattern:
      /\bi identify\b|\bself[- ]identif\w*|\bmy (?:gender|race|ethnicity|disability|veteran status|sexual orientation)\b|\bprotected veteran\b|\bhave a disability\b|\b(?:i am|i'm)\s+(?:not\s+)?(?:an?\s+)?(?:male|female|man|woman|non[- ]?binary|transgender|hispanic|latino|latina|latinx|white|black|african[- ]american|asian|native american|american indian|alaska native|pacific islander|native hawaiian|veteran|disabled|gay|lesbian|bisexual|heterosexual|straight)\b/i
  },
  // Any other first-person assertion ("I am able to…", "I'm available…"); certification verbs ("I am providing…") are not facts.
  {
    group: "first-person-fact",
    pattern:
      /\b(?:i am|i'm)\b(?!\s+(?:providing|submitting|applying|aware|signing|giving|entering|consenting|authori[sz]ing|agreeing|acknowledging|making|reading|completing|certifying|attesting|confirming|furnishing|supplying)\b)/i
  }
];

/**
 * Marketing, newsletter, and talent-pool opt-ins: never accepted (left unchecked when optional).
 * Text-message opt-ins are never accepted here; the candidate's text rule is `textMessageTopic`.
 */
const MARKETING = /\bnewsletters?\b|\bmarketing\b|\bpromotional\b|\bjob alerts?\b|\btalent (?:community|network|pool)\b|\bfuture (?:job |career )?(?:opportunities|openings|roles|positions)\b|\btext messages?\b|\bsms\b|\bwhatsapp\b|\bsubscribe\b|\bmailing list\b/i;

const DATA_RETENTION = /\b(?:consent|agree|authori[sz]e|permit|allow)\b[^.]{0,160}\b(?:retain|retention|store|storing|stored|keep|keeping|hold|holding)\b[^.]{0,100}\b(?:data|information|details|application|cv|resume)\b|\bretain(?:s|ing)? my (?:personal )?(?:data|information|application)\b|\bhas my consent to retain\b/i;
const DATA_PROCESSING = /\b(?:consent|agree|authori[sz]e|permit|allow)\b[^.]{0,160}\b(?:process|processing|processed|collect|collection|collecting|use|using|transfer|transferring)\b[^.]{0,100}\b(?:personal )?(?:data|information|details)\b/i;
const PRIVACY_POLICY = /\b(?:agree|consent|accept)\b[^.]{0,80}\b(?:privacy (?:policy|notice|statement)|data (?:protection|privacy) (?:policy|notice|statement)|candidate privacy|applicant privacy|gdpr)\b|\bi have read and (?:agree|accept|consent)\b[^.]{0,80}\bprivacy\b/i;
/**
 * A site's terms and conditions or terms of use (2026-11-24); employment or offer terms are not site terms,
 * and never a statement that also asks about texts (textMessageTopic decides those).
 */
const TERMS = /\b(?:agree|agrees|agreed|consent|accept|accepts|accepted|acknowledge)\b[^.]{0,120}\b(?:terms (?:and|&) conditions|terms of (?:use|service)|terms and policies)\b|\bi have read(?:,? understood,?)? and (?:agree|accept|consent)\w*\b[^.]{0,120}\bterms\b/i;
const EMPLOYMENT_TERMS = /\bterms (?:and|&) conditions of (?:employment|the (?:offer|position|internship|role))\b|\bterms of (?:employment|the offer)\b/i;
/** "<heading>: I agree and consent": a bare agreement after a heading (Greenhouse's one-box question, read with its legend). */
const HEADED_AGREEMENT = /^(.+):\s*(?:yes[,.]?\s*)?(?:i\s+)?(?:agree|accept|consent)(?:\s*(?:,|and|&)\s*(?:i\s+)?(?:agree|accept|consent|acknowledge|understand))*[.!]?$/i;
const TERMS_NOUN = /\bterms (?:and|&) conditions\b|\bterms of (?:use|service)\b|\bterms and policies\b/i;
const PRIVACY_NOUN = /\bprivacy (?:policy|notice|statement)\b|\b(?:candidate|applicant) privacy\b|\bdata (?:privacy|protection)\b|\bgdpr\b/i;
const PERSONAL_DATA_NOUN = /\bpersonal (?:data|information)\b|\bdata processing\b|\bprocessing of (?:my |your )?(?:personal )?(?:data|information)\b/i;

const CERTIFY = /\b(?:certify|attest|affirm|declare|confirm|represent)\b[^.]{0,120}\b(?:true|accurate|correct|complete|truthful)\b/i;
const FALSE_STATEMENTS = /\b(?:false|misleading|inaccurate|incomplete)\b[^.]{0,40}\b(?:statements?|information|answers|representations?)\b|\bmisrepresentations?\b|\bomissions?\b/i;
const CONSEQUENCE = /\b(?:result in|grounds for|lead to|cause|may)\b[^.]{0,60}\b(?:disqualif\w*|reject\w*|dismiss\w*|terminat\w*|withdraw\w*|rescind\w*|revo\w*)\b/i;

const AT_WILL = /\bat[- ]will\b/i;
const NOTICE_READ = /\b(?:acknowledge|have read|read and understand|confirm that i (?:have )?read|reviewed)\b[^.]{0,80}\b(?:privacy (?:notice|policy|statement)|applicant (?:privacy )?notice|notice to applicants|candidate privacy)\b/i;
const TEMPORARY = /\b(?:internship|position|role|assignment)\b[^.]{0,80}\b(?:temporary|fixed[- ]term|limited (?:duration|term)|seasonal)\b|\bnot (?:a )?(?:guarantee|promise|offer) of (?:full[- ]time|permanent|future|continued) employment\b/i;
const EEO_STATEMENT = /\b(?:acknowledge|have read|read and understand|understand|reviewed)\b[^.]{0,80}\b(?:equal (?:employment )?opportunity|eeo|affirmative action)\b/i;

const AUTHORIZATION = /\b(?:authori[sz]e|consent to|agree to|permit|allow|understand)\b[^.]{0,120}\b(?:background (?:check|screening|investigation)s?|consumer reports?|drug (?:test|testing|screen|screening)s?|reference (?:check|checks|checking)|contact(?:ing)? (?:my )?references|employment (?:verification|history verification)|verify (?:my )?(?:employment|education))\b/i;
const ARBITRATION = /\barbitrat\w*/i;
const ARBITRATION_VERB = /\b(?:agree|acknowledge|accept|consent|understand)\b/i;

/**
 * A notice that the process will require a background check, employment or
 * education verification, or a drug screen, answered by acknowledging it
 * ("Subject to applicable federal and/or state law, you will be required at
 * some point in the process to submit to a criminal background check …",
 * littelfuse.wd1, 2026-11-25): a background-check or drug-test authorization.
 * A question ("?") is never one; willingness is the candidate's own fact.
 */
const SCREENING_NOTICE = /\b(?:you will|you'll|you may|candidates will|applicants will)\b[^.?]{0,80}\b(?:required|asked)\b[^.?]{0,80}\bto (?:submit to|undergo|complete)\b[^.?]{0,60}\b(?:background (?:check|screening|investigation)s?|drug (?:test|testing|screen|screening)s?|reference checks?|employment verification|education verification)\b/i;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The candidate's text-message rule (2026-11-20, verbatim: "Texts yes about my application status").
 * Which texts a consent question asks about, read from its label and options together: "application"
 * when it names only texts about this application (its status, the hiring process, interviews),
 * "marketing" when it names only marketing, job alerts, other openings, newsletters, events, or a
 * talent community, and "unclear" when it names both, another channel (WhatsApp, calls, email),
 * neither, or its label was clipped ("…"). Null when it is not a consent question about texts.
 * Deterministic; no model participates. The standing settings never accept texts (MARKETING above);
 * the planner applies this rule first (textMessageConsentDecision, packages/browser/src/standing-fields.ts).
 */
export type TextMessageTopic = "application" | "marketing" | "unclear";

const TEXTS = /\btext[- ]?messag\w*|\btexting\b|\btexts\b|\btext (?:you|me)\b|\bsms\b|\bmms\b|\bwhatsapp\b/i;
const TEXT_CONSENT = /\bconsent\w*|\bagree\w*|\bopt(?:[- ]?(?:in|out)|s? in)\b|\breceiv\w*|\bpermission\b|\bauthori[sz]\w*|\bmay (?:we|i)\b|\bcan we\b|\bok(?:ay)? (?:to|for)\b|\ballow\w*|\bsign (?:me )?up\b|\bsubscri\w*|\bsend (?:you|me)\b|\bwould you like\b/i;
const OTHER_CHANNEL = /\bwhatsapp\b|\bauto[- ]?dial\w*|\bpre-?recorded\b|\bartificial voice\b|\bcalls?\b|\bvoicemails?\b|\be-?mails?\b/i;
const APPLICATION_TEXTS = /\b(?:your|my|this|the) (?:job |internship )?application\b|\bapplication (?:status|updates?|process|progress)\b|\b(?:job|internship) application\b|\bcandidacy\b|\binterview\w*|\bhiring process\b|\brecruit(?:ing|ment) process\b/i;
const MARKETING_TEXTS = /\bmarketing\b|\bpromotion(?:al|s)?\b|\bnewsletters?\b|\bnews\b|\b(?:job|career) alerts?\b|\bjob (?:recommendations?|matches|openings?|postings?)\b|\b(?:future|other|new|similar|relevant|additional|upcoming) (?:job |career |employment )?(?:opportunit(?:y|ies)|openings?|roles?|positions?|jobs|vacancies)\b|\btalent (?:community|network|pool)\b|\b(?:recruiting|career|hiring|company) events?\b|\bspecial offers?\b|\bdeals?\b|\bsurveys?\b|\bsubscri\w*/i;

export function textMessageTopic(question: string, options: readonly string[] = []): TextMessageTopic | null {
  const label = normalize(question);
  const text = normalize([label, ...options].join(" "));
  if (!TEXTS.test(text) || !TEXT_CONSENT.test(text)) return null;
  if (label.endsWith("…") || OTHER_CHANNEL.test(text)) return "unclear";
  const application = APPLICATION_TEXTS.test(text);
  const marketing = MARKETING_TEXTS.test(text);
  if (application && marketing) return "unclear";
  return application ? "application" : marketing ? "marketing" : "unclear";
}

/** Every fact group whose pattern a statement matches, in list order. */
export function factGroupsOf(text: string): FactGroup[] {
  const statement = normalize(text);
  return FACT_GROUPS.filter(({ pattern }) => pattern.test(statement)).map(({ group }) => group);
}

export type StandingClassification = { groups: StandingGroup[]; fact: boolean; factGroups: FactGroup[]; marketing: boolean; truncated: boolean };

/** Which whitelisted kinds a statement is, and whether a fact or marketing veto or a clipped label applies. */
export function classifyStandingStatement(text: string): StandingClassification {
  const statement = normalize(text);
  const groups: StandingGroup[] = [];
  if (DATA_RETENTION.test(statement)) groups.push("data-retention");
  if (DATA_PROCESSING.test(statement)) groups.push("data-processing");
  if (PRIVACY_POLICY.test(statement)) groups.push("privacy-policy");
  const headed = HEADED_AGREEMENT.exec(statement)?.[1] ?? "";
  if ((TERMS.test(statement) || TERMS_NOUN.test(headed)) && !EMPLOYMENT_TERMS.test(statement) && textMessageTopic(statement) === null) groups.push("terms-of-use");
  if (PRIVACY_NOUN.test(headed) && !groups.includes("privacy-policy")) groups.push("privacy-policy");
  if (PERSONAL_DATA_NOUN.test(headed) && !groups.includes("data-processing")) groups.push("data-processing");
  if (CERTIFY.test(statement) || (FALSE_STATEMENTS.test(statement) && CONSEQUENCE.test(statement))) groups.push("accuracy-certification");
  const dataMatched = groups.some((group) => DATA_CONSENT_GROUPS.has(group));
  if (AT_WILL.test(statement) || (!dataMatched && NOTICE_READ.test(statement)) || TEMPORARY.test(statement) || EEO_STATEMENT.test(statement)) {
    groups.push("acknowledgment");
  }
  if (AUTHORIZATION.test(statement) || (ARBITRATION.test(statement) && ARBITRATION_VERB.test(statement)) || (SCREENING_NOTICE.test(statement) && !statement.includes("?"))) groups.push("authorization");
  const factGroups = factGroupsOf(statement);
  return {
    groups,
    fact: factGroups.length > 0,
    factGroups,
    marketing: MARKETING.test(statement),
    truncated: statement.endsWith("…")
  };
}

export type StandingDecision =
  | { verdict: "accept"; setting: StandingBasisSetting; groups: StandingGroup[] }
  | { verdict: "fact" }
  | { verdict: "marketing" }
  | { verdict: "needs-setting"; groups: StandingGroup[] }
  | { verdict: "none" };

/**
 * Whether the candidate's settings accept a statement. A clipped label is
 * never accepted; a fact statement and a marketing opt-in always veto; a
 * statement spanning data consent and an attestation needs both settings.
 */
export function standingStatementDecision(text: string, settings: StandingConsentSettings): StandingDecision {
  const classified = classifyStandingStatement(text);
  if (classified.truncated) return { verdict: "none" };
  if (classified.fact) return { verdict: "fact" };
  if (classified.marketing) return { verdict: "marketing" };
  if (classified.groups.length === 0) return { verdict: "none" };
  const needsData = classified.groups.some((group) => DATA_CONSENT_GROUPS.has(group));
  const needsAttestation = classified.groups.some((group) => ATTESTATION_GROUPS.has(group));
  if ((needsData && !settings.acceptDataConsent) || (needsAttestation && !settings.signAttestations)) {
    return { verdict: "needs-setting", groups: classified.groups };
  }
  const setting: StandingBasisSetting = needsData && needsAttestation ? "both" : needsData ? "accept_data_consent" : "sign_attestations";
  return { verdict: "accept", setting, groups: classified.groups };
}

const labelKey = (label: string) => normalize(label).toLocaleLowerCase("en-US").replace(/\s*:\s*$/, "");

const SIGNATURE_DATE = /^(?:date|today'?s date|current date|signature date|date signed|date of signature|signed date)(?:\s*\((?:mm\/dd\/yyyy|dd\/mm\/yyyy|yyyy-mm-dd|mm-dd-yyyy)\))?$/;
const SIGNATURE_LABELS: RegExp[] = [
  /^(?:applicant(?:'s|s)? |candidate(?:'s|s)? |your )?(?:electronic |e-? ?|digital )?signature\b/,
  /\b(?:electronic|e-|digital) ?signature\b/,
  /\btype (?:your )?(?:full |legal |full legal )?name\b[^.]{0,60}\b(?:sign|signature|signing)\b/,
  /\bsign (?:here|by typing)\b/
];

/** The date box beside an electronic signature ("Date", "Date signed", "Date (MM/DD/YYYY)"). */
export function isSignatureDateLabel(label: string): boolean {
  return SIGNATURE_DATE.test(labelKey(label));
}

/** A text box that takes the candidate's typed name as an electronic signature. */
export function isSignatureLabel(label: string): boolean {
  const key = labelKey(label);
  if (isSignatureDateLabel(key)) return false;
  return SIGNATURE_LABELS.some((pattern) => pattern.test(key));
}

/**
 * Today's date (YYYY-MM-DD) in the signature date box's format: a format hint
 * in the label wins; else a date input takes YYYY-MM-DD; else MM/DD/YYYY.
 */
export function signatureDateValue(today: string, kind: string, label: string): string {
  const [year, month, day] = today.split("-");
  const key = labelKey(label);
  if (key.includes("mm/dd/yyyy")) return `${month}/${day}/${year}`;
  if (key.includes("dd/mm/yyyy")) return `${day}/${month}/${year}`;
  if (key.includes("yyyy-mm-dd")) return `${year}-${month}-${day}`;
  if (key.includes("mm-dd-yyyy")) return `${month}-${day}-${year}`;
  if (kind === "date") return `${year}-${month}-${day}`;
  return `${month}/${day}/${year}`;
}

const AFFIRMATIVE = /^(?:yes|i (?:agree|accept|consent|acknowledge|certify|understand)|agree|accept|acknowledged?|i have read and agree)\b/i;
const NEGATIVE = /\b(?:not|don'?t|do not|decline|disagree|no)\b/i;

/** The one affirmative option of a consent or attestation list ("Yes", "I agree"); null when none or several. */
export function affirmativeOption(options: string[]): string | null {
  const matches = options.filter((option) => {
    const text = normalize(option);
    return AFFIRMATIVE.test(text) && !NEGATIVE.test(text);
  });
  return matches.length === 1 ? matches[0]! : null;
}
