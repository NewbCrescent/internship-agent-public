import type { BrowserField, BrowserFieldKind, RecognizedForm } from "@internship-agent/domain";
import { browserFieldSchema } from "@internship-agent/domain";

import { isCaptchaTokenControl } from "./challenge";

/** A raw form control as read from the page, before interpretation. */
export type RawControl = {
  tag: "input" | "textarea" | "select" | "button";
  type?: string;
  name?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
  /** The value the control already shows, if any. */
  value?: string;
  /**
   * Adapter-internal: a react-select list or a checkbox group read as one
   * control. `autocomplete` (a type-ahead field) is copied onto the field so
   * the planner types and picks a suggestion instead of filling.
   */
  widget?: "combobox" | "checkbox-group" | "autocomplete";
  /**
   * Adapter-internal: a handle for a control with no id or name, written to
   * the element as `data-ia-control` so the field can be found again.
   */
  ref?: string;
};

/** Required markers sites append to labels: `*`, `∗`, `✱`, `＊`, or "(required)". */
const REQUIRED_MARKER = /\s*(?:[*∗✱＊]+|\(required\))\s*$/i;

/**
 * Strips a trailing required marker ("Full name✱", "Phone ✱", "Email *",
 * "Name (required)") and says whether one was there.
 */
export function stripRequiredMarker(label: string): { label: string; marked: boolean } {
  let text = label.trim();
  let marked = false;
  for (let guard = 0; guard < 3 && REQUIRED_MARKER.test(text); guard += 1) {
    text = text.replace(REQUIRED_MARKER, "").trim();
    marked = true;
  }
  return { label: text, marked };
}

/** Button words that are never a question's whole label. */
const ACTION_WORD = /^(?:discard|back|next|previous|submit|cancel|continue|save|close|done|apply|edit|remove|delete)$/i;

const MAX_FIELDS = 120;
const MAX_LABEL = 300;
const MAX_ID = 200;
const MAX_OPTION = 200;
const MAX_OPTIONS = 500;

/**
 * Invisible characters sites draw into labels: soft hyphen, combining
 * grapheme joiner, Arabic letter mark, Hangul fillers, Khmer inherent vowels,
 * Mongolian variation selectors, zero-width space/joiners and direction
 * marks, bidi embeddings and isolates, word joiner and invisible operators,
 * variation selectors, the byte-order mark. Dover's outlined inputs carry an
 * empty notched-outline legend holding only U+200B. Global: use it only with
 * `.replace`, never `.test` (lastIndex makes a global regex stateful).
 * handshake-executor.ts's in-page `collectControlsIn` keeps its own copy.
 */
export const INVISIBLE_CHARACTERS = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

/** Page text with invisible characters removed and whitespace collapsed. */
export function readableText(text: string | null | undefined): string {
  return (text ?? "").replace(INVISIBLE_CHARACTERS, "").replace(/\s+/g, " ").trim();
}

/** A generated UUID, the whole text. */
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A generated UUID anywhere in the text ("question_<uuid>"). */
const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HAS_WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** A control name usable as a label: never a generated id holding a UUID (Dover names custom questions by UUID). */
export function nameAsLabel(name: string | null | undefined): string {
  const text = readableText(name);
  return UUID_IN.test(text) ? "" : text;
}

/** The label text a control reads: its label, then placeholder, then a name that is not a generated id. */
function labelSourceOf(control: RawControl): string {
  for (const candidate of [readableText(control.label), readableText(control.placeholder)]) {
    const text = stripRequiredMarker(candidate).label;
    if (HAS_WORD_CHARACTER.test(text) && !UUID_ONLY.test(text)) return candidate;
  }
  const name = nameAsLabel(control.name);
  return HAS_WORD_CHARACTER.test(name) ? name : "";
}

/** Trims page text to a schema limit instead of rejecting the whole form. */
function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + "…";
}

/** Chatbot controls (e.g. Oracle Digital Assistant) are floating page widgets, never application questions. */
export function isChatbotControl(control: RawControl): boolean {
  return /^oda-|^chatbot|chatbot/i.test(control.id || control.name || "");
}

/**
 * Deterministic form recognition. Labels resolve from aria/label text first,
 * then placeholder, then a name that is not a generated id (no UUID) — never
 * guessed from layout or pixels. Invisible characters are removed first, and
 * a source with no letter or digit left (Dover's U+200B legend) or that is a
 * bare UUID is skipped; with none left the control is "Unlabeled". No model
 * participates: recognition is a pure function of the DOM snapshot.
 */
export function recognizeFields(controls: RawControl[]): BrowserField[] {
  const fields: BrowserField[] = [];
  for (const control of controls.slice(0, MAX_FIELDS)) {
    if (control.tag === "button") continue;
    if (control.tag === "input" && ["submit", "hidden", "image", "button", "reset"].includes((control.type ?? "").toLowerCase())) {
      continue;
    }
    // The hidden CAPTCHA token field is page machinery, never a question.
    if (isCaptchaTokenControl(control) || isChatbotControl(control)) continue;
    const stripped = stripRequiredMarker(labelSourceOf(control));
    const label = stripped.label;
    const labelMarked = stripRequiredMarker(readableText(control.label)).marked;
    // An unknown control labelled only with an action word ("Discard", "Next") is a button, not a field.
    if (kindOf(control) === "unknown" && ACTION_WORD.test(label.trim())) continue;
    const options = control.options?.map((option) => clip(readableText(option), MAX_OPTION)).filter(Boolean).slice(0, MAX_OPTIONS);
    fields.push(browserFieldSchema.parse({
      id: clip(control.id || control.name || control.ref || `${control.tag}-${fields.length}`, MAX_ID),
      label: clip(label || `Unlabeled ${control.tag} control ${fields.length + 1}`, MAX_LABEL),
      kind: kindOf(control),
      required: (control.required ?? false) || stripped.marked || labelMarked,
      options,
      currentValue: control.value?.trim() ? clip(control.value.trim(), MAX_LABEL) : undefined,
      widget: control.widget === "autocomplete" ? "autocomplete" : undefined
    }));
  }
  return fields;
}

export function recognizeForm(url: string, title: string, controls: RawControl[]): RecognizedForm {
  return { url, title: title.slice(0, 300), fields: recognizeFields(controls) };
}

function kindOf(control: RawControl): BrowserFieldKind {
  if (control.tag === "textarea") return "textarea";
  if (control.tag === "select") return "select";
  if (control.tag !== "input") return "unknown";
  switch ((control.type ?? "text").toLowerCase()) {
    case "email": return "email";
    case "tel": return "tel";
    case "url": return "url";
    case "date": return "date";
    case "file": return "file";
    case "checkbox": return "checkbox";
    case "radio": return "radio";
    case "number": return "number";
    case "text":
    case "search":
    case "month":
      return "text";
    default:
      return "unknown";
  }
}

/**
 * A label that names a CAPTCHA or bot check. "Challenge" alone is not one
 * ("Describe a technical challenge you solved"); visible challenge widgets
 * are found by challenge.ts instead.
 */
const SAFEGUARD_PATTERN = /\b(?:captcha|recaptcha|hcaptcha|bot check|prove you.?re (?:a )?human|verify (?:that )?you(?:'re| are) (?:a )?human|are you a robot|i'?m not a robot|security check|(?:captcha|security|human verification) challenge|access denied)\b/i;

/** The label recognizeFields gives a control with no label, placeholder, or name. */
export const UNLABELED_CONTROL_LABEL = /^Unlabeled (?:input|textarea|select|button) control \d+$/;

/** Labels that must pause the run instead of being filled or submitted past. */
export function isSafeguardField(field: BrowserField): boolean {
  return SAFEGUARD_PATTERN.test(field.label);
}

/** Button labels that count as the terminal application submit. */
export function isSubmitControl(control: RawControl): boolean {
  if (control.tag !== "button" && (control.type ?? "").toLowerCase() !== "submit") return false;
  const text = `${control.label ?? ""} ${control.type ?? ""}`;
  return /\b(submit|apply|send application|complete application)\b/i.test(text);
}

/**
 * Confirmation phrases. The longer ones ("thank you for applying", "we've
 * received your application") come before the bare "thank you", so they tally
 * as their own phrases: a job description that already says "Thank you for
 * your interest" cannot hide a later "Thank you for applying".
 */
const CONFIRMATION_PATTERN = /\b(thanks for applying|application (?:has been|was|is) (?:successfully )?(?:submitted|received|complete)|thank you for applying|we[’']ve received your application|we have received your application|thank you|application received|successfully submitted|confirmation|we received your application|application submitted|applied on|submission received|applied successfully)\b/i;

/**
 * Confirmation that appeared because of the submit click: the phrase must
 * occur more often after the click than before it, so a page that already
 * says "confirmation" or "thank you" cannot pass for a submitted one. Each
 * phrase is counted on its own ("thank you for applying" is not "thank you").
 */
export function readNewConfirmation(before: string, after: string): string | null {
  const counts = (text: string) => {
    const tally = new Map<string, { count: number; text: string }>();
    for (const match of text.match(new RegExp(CONFIRMATION_PATTERN.source, "gi")) ?? []) {
      const phrase = match.toLocaleLowerCase("en-US");
      const entry = tally.get(phrase);
      tally.set(phrase, { count: (entry?.count ?? 0) + 1, text: entry?.text ?? match });
    }
    return tally;
  };
  const earlier = counts(before);
  for (const [phrase, entry] of counts(after)) {
    if (entry.count > (earlier.get(phrase)?.count ?? 0)) return entry.text;
  }
  return null;
}

/** Confirmation detection on the landing page after submit. */
export function readConfirmationFromText(bodyText: string): string | null {
  const match = bodyText.match(CONFIRMATION_PATTERN);
  return match ? match[0].slice(0, 2_000) : null;
}

/**
 * Waits until a page's form has rendered: controls exist and their count
 * holds steady for `stableMs`. Client-rendered forms (Ashby, parts of
 * Greenhouse) draw fields seconds after the load event. Gives up quietly at
 * `timeoutMs` so the caller reads whatever is there.
 */
export async function waitForStableControls(
  count: () => Promise<number>,
  options: { intervalMs?: number; stableMs?: number; timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<number> {
  const intervalMs = options.intervalMs ?? 250;
  const stableMs = options.stableMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  let last = await count();
  let steadySince = now();
  while (now() - started < timeoutMs) {
    if (last > 0 && now() - steadySince >= stableMs) return last;
    await sleep(intervalMs);
    const current = await count();
    if (current !== last) { last = current; steadySince = now(); }
  }
  return last;
}
