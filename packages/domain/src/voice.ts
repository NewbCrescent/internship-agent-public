/**
 * Which application questions a model may draft in the candidate's voice.
 * Drafting is for open-ended prose only. Anything that is a fact about the
 * candidate (dates, authorization, contact, education, compensation), a
 * protected or demographic answer, or an attestation is never drafted: it
 * comes from recorded facts or from the candidate directly.
 */
const NEVER_DRAFTED = /\b(salary|compensation|pay|wages?|dates?|start|end|graduat\w*|gpa|grades?|authori[sz]\w*|sponsor\w*|visa|citizen\w*|clearance|gender|sex|race|ethnic\w*|hispanic|latin[oax]|veteran|disabilit\w*|disabled|pronouns?|orientation|age|address|city|state|zip|postal|country|phone|e-?mail|names?|linkedin|github|website|portfolio|url|links?|referr\w*|referred|hear about|password|signature|sign|certif\w*|attest\w*|agree\w*|acknowledg\w*|consent|relocat\w*|availab\w*|notice period|years of experience|school|university|college|degree|major|minor)\b/i;
const OPEN_ENDED = /\b(why|describe|tell us|tell me|explain|what (?:excites|interests|motivates|draws|makes)|how (?:would|do|did|have)|share|walk us through|cover letter|interested in)\b/i;

/** The recognizer's placeholder for a control with no readable label ("Unlabeled textarea control 2"). */
const UNLABELED = /^Unlabeled \S+ control \d+$/;

/** A field with no readable label is never sent to the drafter. */
export function isDraftableQuestion(field: { label: string; kind: string }): boolean {
  if (UNLABELED.test(field.label.trim())) return false;
  if (NEVER_DRAFTED.test(field.label)) return false;
  if (field.kind === "textarea") return true;
  return field.kind === "text" && field.label.length >= 20 && OPEN_ENDED.test(field.label);
}
