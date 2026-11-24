import type { BrowserField, FillDecision, RecognizedForm } from "@internship-agent/domain";
import {
  affirmativeOption,
  isSignatureDateLabel,
  isSignatureLabel,
  signatureDateValue,
  standingStatementDecision,
  type StandingBasisSetting,
  type StandingConsentSettings
} from "@internship-agent/domain";

/**
 * The candidate's standing settings for one run (packages/domain
 * standing-consent.ts), with the name an electronic signature types (the
 * saved legal first and last name, else the full name) and today's local
 * date (YYYY-MM-DD) for the signature's date box.
 */
export type StandingInputs = StandingConsentSettings & { signatureName?: string; today?: string };

/** The plain reason an electronic-signature box waits for the candidate. */
export const SIGNATURE_QUESTION = "electronic signature: needs your OK";
/** The plain reason a required marketing or newsletter opt-in waits for the candidate. */
export const MARKETING_QUESTION = "marketing opt-in: needs your OK";
const SIGNATURE_NO_NAME = "electronic signature: add your legal first and last name (or full name) on the profile page";

const TYPED_KINDS: ReadonlySet<BrowserField["kind"]> = new Set(["text", "textarea"]);

function pause(field: BrowserField, question: string): FillDecision {
  return { fieldId: field.id, action: "pause", value: null, basis: null, reason: question, pause: { question, key: null, scope: null, safeguard: false } };
}

const SETTING_TEXT: Record<StandingBasisSetting, string> = {
  accept_data_consent: "data-consent",
  sign_attestations: "attestation",
  both: "data-consent and attestation"
};

/**
 * A decision for a consent, attestation, or signature field under the
 * candidate's standing settings, or null to leave the field to the usual
 * rules. A signature box always waits for the candidate unless the
 * attestation setting is on and a name is saved; every other field is
 * decided here only when `standing` is given. Fact statements, unknown
 * statements, and checkbox groups return null.
 */
export function standingFieldDecision(field: BrowserField, form: RecognizedForm, standing: StandingInputs | undefined): FillDecision | null {
  if (TYPED_KINDS.has(field.kind) && isSignatureLabel(field.label)) {
    if (standing?.signAttestations && standing.signatureName) {
      return {
        fieldId: field.id,
        action: "fill",
        value: standing.signatureName,
        basis: { kind: "standing_consent", setting: "sign_attestations", group: "e-signature", statement: field.label },
        reason: "Signed with your saved legal name under your standing attestation setting.",
        pause: null
      };
    }
    return pause(field, standing?.signAttestations ? SIGNATURE_NO_NAME : SIGNATURE_QUESTION);
  }
  if (!standing) return null;
  const noOptions = !field.options?.length;
  if ((field.kind === "date" || field.kind === "text") && noOptions && isSignatureDateLabel(field.label)) {
    const signed = form.fields.some((other) => other.id !== field.id && TYPED_KINDS.has(other.kind) && isSignatureLabel(other.label));
    if (standing.signAttestations && standing.today && signed) {
      return {
        fieldId: field.id,
        action: "fill",
        value: signatureDateValue(standing.today, field.kind, field.label),
        basis: { kind: "standing_consent", setting: "sign_attestations", group: "signature-date", statement: field.label },
        reason: "Today's date beside your electronic signature, under your standing attestation setting.",
        pause: null
      };
    }
    return null;
  }
  if (field.kind === "checkbox" && (field.options?.length ?? 0) < 2) {
    const decision = standingStatementDecision(field.label, standing);
    if (decision.verdict === "accept") {
      return {
        fieldId: field.id,
        action: "check",
        value: "true",
        basis: { kind: "standing_consent", setting: decision.setting, group: decision.groups[0]!, statement: field.label },
        reason: `Accepted under your standing ${SETTING_TEXT[decision.setting]} setting.`,
        pause: null
      };
    }
    if (decision.verdict === "marketing" && (standing.acceptDataConsent || standing.signAttestations)) {
      if (!field.required) {
        return { fieldId: field.id, action: "skip", value: null, basis: null, reason: "Marketing or newsletter opt-in left unchecked.", pause: null };
      }
      return pause(field, MARKETING_QUESTION);
    }
    return null;
  }
  if ((field.kind === "select" || field.kind === "radio") && (field.options?.length ?? 0) >= 2) {
    const decision = standingStatementDecision(field.label, standing);
    const option = decision.verdict === "accept" ? affirmativeOption(field.options!) : null;
    if (decision.verdict === "accept" && option) {
      return {
        fieldId: field.id,
        action: "choose",
        value: option,
        basis: { kind: "standing_consent", setting: decision.setting, group: decision.groups[0]!, statement: field.label },
        reason: `Accepted under your standing ${SETTING_TEXT[decision.setting]} setting.`,
        pause: null
      };
    }
    return null;
  }
  return null;
}
