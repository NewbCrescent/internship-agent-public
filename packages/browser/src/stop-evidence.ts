import type { BrowserPage } from "./handshake-executor";
import { isBenignAlertText, stripUrlQuery } from "./submission-outcome";

/**
 * Stop evidence (Track 42): the first time each kind of pause or stop happens
 * in a run, the orchestrator saves one small capture of the page while it is
 * still open (packages/agent/src/submit-evidence.ts saveStopEvidenceQuietly).
 * This module reads it: the query-stripped URL, the visible text, the site's
 * alert text, and a bounded, sanitized excerpt of the region the stop
 * concerns (the field's form-field container, the history section, or for a
 * page-level stop the page's main region with its iframes and Apply-like
 * controls). Every read is read-only: nothing is clicked, focused, typed,
 * tagged, or scrolled, and input values are never read.
 */

export const STOP_KINDS = ["history-row", "unfillable-field", "unanswerable-question", "no-form", "run-failed", "step-transition"] as const;
export type StopKind = (typeof STOP_KINDS)[number];

export type StopRegionRequest =
  | { kind: "field"; fieldId: string; label: string }
  | { kind: "section"; label: string }
  | { kind: "page" };

export type StopFrame = { src: string; title: string; name: string; width: number; height: number; visible: boolean };
export type StopControl = { tag: string; text: string; href: string | null; role: string | null; ariaLabel: string; disabled: boolean; visible: boolean };
export type StopRegion = { anchor: string; html: string; truncated: boolean; frames: StopFrame[]; applyControls: StopControl[] };
export type StopCapture = { url: string; bodyText: string; alertText: string; region: StopRegion | null };

/** The most characters of region markup a capture keeps. */
export const STOP_REGION_MAX_HTML = 12_000;
const STOP_READ_TIMEOUT_MS = 5_000;
const STOP_MAX_BODY_TEXT = 20_000;

/**
 * Runs in the page (page.evaluate): self-contained, no outer references.
 * Finds the region the request names and serializes it compactly: comments,
 * scripts and styles dropped, text nodes redacted (emails, URL queries, long
 * digit runs) and clipped, only an allow-list of attributes kept (never
 * `value`, `checked`, `selected`, `style`, or event handlers), textarea and
 * contenteditable contents replaced, and hidden elements marked `ia-hidden`.
 * Reads only.
 */
export function readStopRegionIn(request: StopRegionRequest): StopRegion {
  const MAX_HTML = 12_000;
  const MAX_ELEMENTS = 600;
  const MAX_DEPTH = 30;
  const MAX_TEXT = 160;
  const CONTROLS = 'input:not([type="hidden"]), select, textarea, button, [role="combobox"], [role="listbox"], [role="radio"], [role="checkbox"], [contenteditable="true"], [contenteditable=""]';
  const SKIPPED = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META"]);
  const VOID = new Set(["input", "img", "br", "hr"]);
  const REF_ATTRIBUTES = new Set(["id", "name", "for", "data-automation-id", "data-ia-control", "data-ia-section", "data-ia-panel", "aria-labelledby", "aria-describedby", "aria-controls"]);
  const OTHER_ATTRIBUTES = new Set([
    "type", "role", "href", "src", "action", "method", "target", "placeholder", "alt", "title", "disabled", "required", "readonly", "hidden",
    "multiple", "accept", "autocomplete", "tabindex", "class", "data-testid", "data-test", "data-qa", "data-uxi-widget-type", "aria-label",
    "aria-expanded", "aria-haspopup", "aria-hidden", "aria-invalid", "aria-required", "aria-disabled", "aria-modal", "aria-live", "aria-busy"
  ]);
  const URL_ATTRIBUTES = new Set(["href", "src", "action"]);
  const VALUE_TAGS = new Set(["input", "select", "textarea"]);
  const APPLY_TEXT = /\b(?:apply|start|begin|continue|next|submit|i'?m interested|interested|sign in|log ?in|create (?:an )?account|register|guest|upload)\b/i;

  const normalize = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
  const redact = (value: string | null | undefined): string => normalize(value)
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1")
    .replace(/\d{7,}/g, "[number]");
  const clipText = (value: string, max: number): string => (value.length <= max ? value : value.slice(0, max));
  const escapeText = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escapeAttribute = (value: string): string => escapeText(value).replace(/"/g, "&quot;");
  const stripQuery = (value: string | null): string => {
    if (!value) return "";
    try {
      const parsed = new URL(value, location.href);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return "";
    }
  };
  const shown = (element: Element): boolean => {
    if (element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const controlCount = (element: Element): number => element.querySelectorAll(CONTROLS).length;
  const query = (selector: string): Element | null => {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };
  const textOf = (element: Element): string => normalize((element as HTMLElement).innerText ?? element.textContent);
  const labelledText = (element: Element): string => {
    const ids = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    const named = ids.map((id) => {
      const target = document.getElementById(id);
      return target ? textOf(target) : "";
    }).join(" ");
    return `${element.getAttribute("aria-label") ?? ""} ${named}`.toLowerCase();
  };

  // ---- The anchor the request names ----
  let anchor: Element | null = null;
  let anchorKind = "none";
  if (request.kind === "field") {
    const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(request.fieldId) : request.fieldId.replace(/["\\]/g, "\\$&");
    const byId = (() => {
      try {
        return document.getElementById(request.fieldId);
      } catch {
        return null;
      }
    })();
    const attempts: Array<[string, () => Element | null]> = [
      ["id", () => byId],
      ["name", () => query(`[name="${escaped}"]`)],
      ["data-ia-control", () => query(`[data-ia-control="${escaped}"]`)],
      ["data-automation-id", () => query(`[data-automation-id="${escaped}"]`)]
    ];
    for (const [kind, find] of attempts) {
      const found = find();
      if (found) {
        anchor = found;
        anchorKind = kind;
        break;
      }
    }
    if (!anchor) {
      const wanted = normalize(request.label).toLowerCase().slice(0, 80);
      if (wanted) {
        for (const label of Array.from(document.querySelectorAll("label, legend"))) {
          if (normalize(label.textContent).toLowerCase().startsWith(wanted)) {
            anchor = label;
            anchorKind = "label";
            break;
          }
        }
      }
    }
  } else if (request.kind === "section") {
    const wanted = normalize(request.label).toLowerCase();
    for (const group of Array.from(document.querySelectorAll('[role="group"]'))) {
      if (wanted && labelledText(group).includes(wanted)) {
        anchor = group;
        anchorKind = "role=group";
        break;
      }
    }
    if (!anchor) {
      const section = query(wanted.includes("education") ? '[data-ia-section="education"]' : '[data-ia-section="work"]');
      if (section) {
        anchor = section;
        anchorKind = "data-ia-section";
      }
    }
    if (!anchor && wanted) {
      for (const heading of Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, legend, [role="heading"]'))) {
        if (normalize(heading.textContent).toLowerCase().includes(wanted)) {
          anchor = heading;
          anchorKind = "heading";
          break;
        }
      }
    }
  } else {
    const candidates: Array<[string, Element | null]> = [
      ["apply-flow", query('[data-automation-id="applyFlowPage"]')],
      ["main", query('main, [role="main"]')],
      ["form", query("form")],
      ["body", document.body]
    ];
    for (const [kind, found] of candidates) {
      if (found) {
        anchor = found;
        anchorKind = kind;
        break;
      }
    }
  }

  // ---- The region around the anchor ----
  let region: Element | null = anchor;
  if (anchor && request.kind === "field") {
    const container = anchor.closest('[data-automation-id^="formField"], fieldset, [role="group"], [role="radiogroup"], .field, .form-group, .application-question, li');
    if (container && container !== document.body && controlCount(container) <= 12) {
      region = container;
    } else {
      let current: Element = anchor;
      for (let step = 0; step < 4; step += 1) {
        const parent: Element | null = current.parentElement;
        if (!parent || parent === document.body || controlCount(parent) > 6) break;
        current = parent;
      }
      region = current;
    }
  } else if (anchor && request.kind === "section" && anchorKind === "heading") {
    let current: Element = anchor;
    for (let step = 0; step < 3; step += 1) {
      const parent: Element | null = current.parentElement;
      if (!parent || parent === document.body || controlCount(parent) > 40) break;
      current = parent;
    }
    region = current;
  }

  // ---- The serializer ----
  let html = "";
  let elements = 0;
  let truncated = false;
  const append = (piece: string): boolean => {
    if (truncated) return false;
    if (html.length + piece.length > MAX_HTML) {
      truncated = true;
      return false;
    }
    html += piece;
    return true;
  };
  const attributesOf = (element: Element, tag: string): string => {
    let out = "";
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (REF_ATTRIBUTES.has(name)) {
        out += ` ${name}="${escapeAttribute(clipText(normalize(attribute.value), MAX_TEXT))}"`;
        continue;
      }
      if (!OTHER_ATTRIBUTES.has(name)) continue;
      if (name === "title" && VALUE_TAGS.has(tag)) continue;
      const raw = URL_ATTRIBUTES.has(name) ? stripQuery(attribute.value) : attribute.value;
      const max = name === "class" ? 80 : MAX_TEXT;
      out += ` ${name}="${escapeAttribute(clipText(redact(raw), max))}"`;
    }
    if (!shown(element)) out += ' ia-hidden=""';
    return out;
  };
  const serialize = (node: Node, depth: number): void => {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = clipText(redact(node.textContent), MAX_TEXT);
      if (text) append(escapeText(text));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (SKIPPED.has(element.tagName)) return;
    if (depth > MAX_DEPTH || elements >= MAX_ELEMENTS) {
      truncated = true;
      return;
    }
    elements += 1;
    const tag = element.tagName.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "element";
    if (!append(`<${tag}${attributesOf(element, tag)}>`)) return;
    if (VOID.has(tag)) return;
    if (tag === "svg") {
      append(`</${tag}>`);
      return;
    }
    if (tag === "textarea" || element.hasAttribute("contenteditable")) {
      append("[text not kept]");
    } else {
      for (const child of Array.from(element.childNodes)) {
        serialize(child, depth + 1);
        if (truncated) return;
      }
    }
    append(`</${tag}>`);
  };
  if (region) serialize(region, 0);

  // ---- Frames and Apply-like controls, for a page-level stop ----
  const frames: StopFrame[] = [];
  const applyControls: StopControl[] = [];
  if (request.kind === "page") {
    for (const frame of Array.from(document.querySelectorAll("iframe, frame"))) {
      if (frames.length >= 20) break;
      const box = frame.getBoundingClientRect();
      frames.push({
        src: clipText(stripQuery(frame.getAttribute("src")), 500),
        title: clipText(redact(frame.getAttribute("title")), 200),
        name: clipText(redact(frame.getAttribute("name")), 100),
        width: Math.max(0, Math.round(box.width)),
        height: Math.max(0, Math.round(box.height)),
        visible: shown(frame)
      });
    }
    for (const control of Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]'))) {
      if (applyControls.length >= 20) break;
      const input = control instanceof HTMLInputElement ? control : null;
      const text = normalize(input ? input.getAttribute("value") : textOf(control)) || normalize(control.getAttribute("aria-label"));
      if (!APPLY_TEXT.test(text)) continue;
      const tag = control.tagName.toLowerCase();
      applyControls.push({
        tag,
        text: clipText(redact(text), 120),
        href: tag === "a" ? clipText(stripQuery(control.getAttribute("href")), 500) : null,
        role: control.getAttribute("role"),
        ariaLabel: clipText(redact(control.getAttribute("aria-label")), 120),
        disabled: (control as HTMLButtonElement).disabled === true || control.getAttribute("aria-disabled") === "true",
        visible: shown(control)
      });
    }
  }
  return { anchor: region ? anchorKind : "none", html, truncated, frames, applyControls };
}

/** A read that gives `fallback` when it rejects or takes longer than `ms`. */
async function withTimeout<T>(read: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read().catch(() => fallback),
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reads one stop capture from the open page: never throws, never clicks or
 * types, and each read is bounded by 5 seconds. The screenshot is taken by
 * the caller, which owns the folder.
 */
export async function captureStopEvidence(page: BrowserPage, request: StopRegionRequest): Promise<StopCapture> {
  let url = "";
  try {
    url = stripUrlQuery(page.url());
  } catch {
    url = "";
  }
  const bodyText = (await withTimeout(() => page.bodyText(), STOP_READ_TIMEOUT_MS, "")).slice(0, STOP_MAX_BODY_TEXT);
  let alertText = page.alertText ? (await withTimeout(() => page.alertText!(), STOP_READ_TIMEOUT_MS, "")).trim() : "";
  try {
    if (isBenignAlertText(alertText)) alertText = "";
  } catch {
    alertText = "";
  }
  const region = page.stopRegion ? await withTimeout<StopRegion | null>(() => page.stopRegion!(request), STOP_READ_TIMEOUT_MS, null) : null;
  return { url, bodyText, alertText, region };
}
