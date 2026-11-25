import type { AshbySubmitNetwork } from "./ashby-network";

/**
 * Read-only diagnostics of an Ashby submit click (Track 27). Source: Ashby's
 * public front-end bundle (index-DYvFpVME.js, read 2026-11-25, no submission
 * made): its submit handler checks only pending answer saves, then asks
 * reCAPTCHA Enterprise for a token, reads a device fingerprint, and POSTs the
 * submit mutation to `/api/non-user-graphql`; it registers no service worker.
 *
 * Read-only: the recorder listens to Playwright's own page events (requests,
 * responses, failures, console messages, page errors) and the in-page
 * functions read the DOM. Nothing here wraps or changes a site script, and
 * nothing changes a fingerprint or an automation flag.
 *
 * Privacy: raw console messages and the page's typed values live in memory
 * only. Only sanitized strings leave `snapshot`: the page's own values (and
 * their words), file names, emails, URL queries and fragments, and long
 * numbers are removed, and a text is dropped entirely when the page's values
 * could not be read.
 */

export type AshbyClickCheck = {
  /** The clicked control carries Ashby's `ashby-application-form-submit-button` class. */
  ashbySubmitButton: boolean;
  /** document.elementFromPoint at the control's centre, read just before the click, is the control or inside it. */
  hitTarget: boolean;
  /** When hitTarget is false: the element found there as tag plus at most 3 class names (no text); null otherwise or when nothing was found. */
  hitElement: string | null;
  tag: string;
  /** The control's type attribute as written; null when absent. */
  typeAttribute: string | null;
  /** The control's text, collapsed, at most 60 characters (sanitized at snapshot). */
  text: string;
};

export type AshbyRequestEntry = {
  method: string;
  host: string;
  path: string;
  resourceType: string;
  /** Submit clicks made when the group's first request started. */
  clicks: number;
  count: number;
  lastStatus: number | null;
  failed: boolean;
};

export type AshbyConsoleEntry = { kind: "error" | "warning" | "page-error"; text: string; clicks: number };

export type AshbySubmitDiagnostics = {
  /** One per submit click, at most 5. */
  clicks: AshbyClickCheck[];
  /** Requests started after the first click, grouped by method+host+path, at most 80 groups. */
  requests: AshbyRequestEntry[];
  /** Groups not kept over the cap. */
  requestsDropped: number;
  /** Console errors and warnings and page errors since the watch started, at most 20. */
  console: AshbyConsoleEntry[];
  consoleDropped: number;
  /** Visible validation and error elements at snapshot, at most 10, each at most 200 characters. */
  visibleErrors: string[];
};

/** The challenge detail of the not-sent hold. */
export const ASHBY_NOT_SENT_DETAIL = "Ashby sent no submit request after the click on its Submit Application button";

/** Ashby's answer-save mutations (ashby-network.ts's header comment). */
export const ASHBY_SAVE_OPERATIONS: ReadonlySet<string> = new Set([
  "ApiSetFormValue",
  "ApiSetFormValueToFile",
  "ApiAddManyFilesToFormValue",
  "ApiCreateFileUploadHandle"
]);

const MAX_CLICK_CHECKS = 5;
const MAX_REQUEST_GROUPS = 80;
const MAX_CONSOLE = 20;
const MAX_RAW_CONSOLE = 1_000;
const MAX_VISIBLE_ERRORS = 10;
const MAX_PATH = 160;
const MAX_TEXT = 200;
const MAX_CLICK_TEXT = 60;
/** ashby-network.ts's MAX_CALLS: a record this long may have missed a call. */
const NETWORK_CALL_CAP = 40;
const FILE_SEGMENT = /\.(?:pdf|docx?|rtf|odt|txt|png|jpe?g|gif|heic)$/i;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/gi;
const EMAIL_IN_TEXT = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const LONG_NUMBER = /\d{7,}/g;
const VALUE_TOKEN_SPLIT = /[\s,;:@/\\|()<>"'.+_-]+/;

/** Method, host and path of a request URL, never its query or fragment; null when it does not parse. */
export function diagnosticRequestTarget(url: string): { host: string; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (protocol !== "http" && protocol !== "https") return { host: protocol, path: "" };
  const path = parsed.pathname
    .split("/")
    .map((segment) => {
      if (segment.includes("@") || /%40/i.test(segment)) return "[redacted]";
      if (FILE_SEGMENT.test(segment)) return "[file]";
      return segment.replace(LONG_NUMBER, "[number]");
    })
    .join("/")
    .slice(0, MAX_PATH);
  return { host: parsed.hostname.toLowerCase(), path };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A page text with URL queries and fragments, the page's own values
 * (`values`, from scrubValuesFrom), emails, and long numbers removed, at most 200 characters; ""
 * when the values could not be read (null), so the text is not kept.
 */
export function sanitizeDiagnosticText(text: string, values: readonly string[] | null): string {
  if (values === null) return "";
  let result = text.replace(/\s+/g, " ").trim().slice(0, 400);
  // URLs first: a value's word inside a URL ("https", a host) would otherwise break the URL and keep its query.
  result = result.replace(URL_IN_TEXT, (url) => {
    const target = diagnosticRequestTarget(url);
    return target ? `${target.host}${target.path}` : "[url]";
  });
  const known = [...new Set(values.filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
  if (known.length > 0) result = result.replace(new RegExp(known.map(escapeRegExp).join("|"), "gi"), "[redacted]");
  result = result.replace(EMAIL_IN_TEXT, "[email]").replace(LONG_NUMBER, "[number]");
  return result.slice(0, MAX_TEXT);
}

/** The strings to scrub from page texts: each value of length 3 or more, then the words (4+) of each value up to 200 characters. */
export function scrubValuesFrom(raw: readonly string[]): string[] {
  const values = raw.map((value) => value.trim()).filter((value) => value.length >= 3);
  const out = new Set<string>(values);
  for (const value of values) {
    if (value.length > 200) continue;
    for (const token of value.split(VALUE_TOKEN_SPLIT)) if (token.length >= 4) out.add(token);
  }
  return [...out].slice(0, 300);
}

const isAshbyHost = (host: string): boolean => host === "ashbyhq.com" || host.endsWith(".ashbyhq.com");

/**
 * True only when the click provably reached Ashby's submit button and Ashby
 * sent nothing: no submit mutation, no Ashby GraphQL call after the click
 * other than answer saves (and the network record not full), every click
 * check on Ashby's button with its hit test passing, no request group
 * dropped, and no other POST or PUT to Ashby. Anything else is false.
 */
export function ashbyClickSentNothing(network: AshbySubmitNetwork | null, diagnostics: AshbySubmitDiagnostics | null): boolean {
  if (!network || !diagnostics) return false;
  if (network.submits.length > 0) return false;
  if (network.calls.length >= NETWORK_CALL_CAP) return false;
  if (network.calls.some((call) => call.clicks >= 1 && !ASHBY_SAVE_OPERATIONS.has(call.operation))) return false;
  if (diagnostics.clicks.length < 1) return false;
  if (!diagnostics.clicks.every((check) => check.ashbySubmitButton && check.hitTarget)) return false;
  if (diagnostics.requestsDropped !== 0) return false;
  const otherAshbyWrite = diagnostics.requests.some((entry) =>
    (entry.method === "POST" || entry.method === "PUT") && isAshbyHost(entry.host) && entry.path !== "/api/non-user-graphql");
  return !otherAshbyWrite;
}

/** The not-sent hold's message; the required phrase and the URL come first so a 300-character clip keeps them. */
export function ashbyNotSentMessage(url: string): string {
  return `Ashby did not send the application from the agent's browser; submit it yourself at ${url || "the posting's application page"}. The click reached Ashby's Submit Application button, but Ashby sent no submit request (its reCAPTCHA Enterprise check runs before it sends), so nothing was taken. The agent never works around a site's bot check, so this application is held for you; it is not marked submitted and is not retried.`;
}

export type AshbyDiagnosticsRecorder = {
  noteClick(check: AshbyClickCheck | null): void;
  cancelClick(): void;
  request(id: object, url: string, method: string, resourceType: string): void;
  response(id: object, status: number): void;
  failed(id: object): void;
  consoleMessage(type: string, text: string): void;
  pageError(text: string): void;
  snapshot(values: string[] | null, visibleErrors: string[]): AshbySubmitDiagnostics;
};

const UNKNOWN_CHECK = (): AshbyClickCheck => ({ ashbySubmitButton: false, hitTarget: false, hitElement: null, tag: "", typeAttribute: null, text: "" });

/** Records the diagnostics from the page's events (fed by the Playwright adapter). Never throws. */
export function createAshbyDiagnosticsRecorder(): AshbyDiagnosticsRecorder {
  let clicks = 0;
  const checks: AshbyClickCheck[] = [];
  const groups = new Map<string, AshbyRequestEntry>();
  const dropped = new Set<string>();
  const messages: AshbyConsoleEntry[] = [];
  let consoleDropped = 0;
  // Playwright Request objects live as long as the page; a WeakMap never keeps one alive.
  const byRequest = new WeakMap<object, AshbyRequestEntry>();
  const keep = (kind: AshbyConsoleEntry["kind"], text: string): void => {
    if (messages.length < MAX_CONSOLE) messages.push({ kind, text: String(text).slice(0, MAX_RAW_CONSOLE), clicks });
    else consoleDropped += 1;
  };
  return {
    noteClick: (check) => {
      try {
        clicks += 1;
        // An unknown check counts as not proven.
        if (checks.length < MAX_CLICK_CHECKS) checks.push(check ? { ...check } : UNKNOWN_CHECK());
      } catch {
        // never throws
      }
    },
    cancelClick: () => {
      try {
        if (clicks > 0 && checks.length === clicks) checks.pop();
        clicks = Math.max(0, clicks - 1);
      } catch {
        // never throws
      }
    },
    request: (id, url, method, resourceType) => {
      try {
        if (clicks < 1) return;
        const target = diagnosticRequestTarget(url);
        if (target === null) return;
        const verb = String(method).toUpperCase();
        const key = `${verb} ${target.host}${target.path}`;
        let group = groups.get(key);
        if (!group) {
          if (groups.size >= MAX_REQUEST_GROUPS) {
            dropped.add(key);
            return;
          }
          group = { method: verb, host: target.host, path: target.path, resourceType: String(resourceType), clicks, count: 0, lastStatus: null, failed: false };
          groups.set(key, group);
        }
        group.count += 1;
        byRequest.set(id, group);
      } catch {
        // never throws
      }
    },
    response: (id, status) => {
      try {
        const group = byRequest.get(id);
        if (group) group.lastStatus = status;
      } catch {
        // never throws
      }
    },
    failed: (id) => {
      try {
        const group = byRequest.get(id);
        if (group) group.failed = true;
      } catch {
        // never throws
      }
    },
    consoleMessage: (type, text) => {
      try {
        if (type === "error" || type === "warning") keep(type, text);
      } catch {
        // never throws
      }
    },
    pageError: (text) => {
      try {
        keep("page-error", text);
      } catch {
        // never throws
      }
    },
    snapshot: (values, visibleErrors) => {
      try {
        const errors: string[] = [];
        for (const raw of visibleErrors) {
          const text = sanitizeDiagnosticText(String(raw), values);
          if (text && !errors.includes(text) && errors.length < MAX_VISIBLE_ERRORS) errors.push(text);
        }
        return {
          clicks: checks.map((check) => ({ ...check, text: sanitizeDiagnosticText(check.text, values).slice(0, MAX_CLICK_TEXT) })),
          requests: [...groups.values()].map((group) => ({ ...group })),
          requestsDropped: dropped.size,
          console: messages.map((entry) => ({ ...entry, text: sanitizeDiagnosticText(entry.text, values) })),
          consoleDropped,
          visibleErrors: errors
        };
      } catch {
        return { clicks: [], requests: [], requestsDropped: 0, console: [], consoleDropped: 0, visibleErrors: [] };
      }
    }
  };
}

/**
 * In-page (locator.evaluate on the submit control, just before the click):
 * whether it is Ashby's submit button and whether the element at its centre is
 * it. Self-contained: everything it uses is declared here.
 */
export function describeSubmitTargetIn(element: Element): AshbyClickCheck {
  const rect = element.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const hitTarget = hit !== null && (hit === element || element.contains(hit));
  let hitElement: string | null = null;
  if (!hitTarget && hit) {
    const classes = Array.from(hit.classList).slice(0, 3).map((name) => `.${name}`).join("");
    hitElement = `${hit.tagName.toLowerCase()}${classes}`.slice(0, 120);
  }
  return {
    ashbySubmitButton: element.matches(".ashby-application-form-submit-button"),
    hitTarget,
    hitElement,
    tag: element.tagName.toLowerCase(),
    typeAttribute: element.getAttribute("type"),
    text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60)
  };
}

/**
 * In-page (page.evaluate): the page's own values, to scrub them from the
 * diagnostics texts: typed inputs (hidden ones too), textareas, the selected
 * option of each select, and the names of chosen files. Held in memory only.
 * Self-contained.
 */
export function readFormValuesIn(): string[] {
  const skipped = ["checkbox", "radio", "button", "submit", "reset", "image", "file"];
  const out: string[] = [];
  const push = (value: string | null | undefined): void => {
    const text = (value ?? "").trim();
    if (text && out.length < 300) out.push(text);
  };
  for (const input of Array.from(document.querySelectorAll("input"))) {
    const type = (input.type || "text").toLowerCase();
    if (type === "file") {
      for (const file of Array.from(input.files ?? [])) push(file.name);
      continue;
    }
    if (!skipped.includes(type)) push(input.value);
  }
  for (const area of Array.from(document.querySelectorAll("textarea"))) push(area.value);
  for (const select of Array.from(document.querySelectorAll("select"))) {
    for (const option of Array.from(select.selectedOptions)) push(option.text);
  }
  return out;
}

/**
 * In-page (page.evaluate): visible validation and error elements (alerts,
 * Ashby's failure containers, anything classed as an error, invalid, or a
 * toast). An invalid form control is named, not read. Self-contained.
 */
export function readAshbyVisibleErrorsIn(): string[] {
  const selector = [
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[aria-invalid="true"]',
    ".ashby-application-form-failure-container",
    ".ashby-application-form-blocked-application-container",
    '[class*="error" i]',
    '[class*="invalid" i]',
    '[class*="toast" i]'
  ].join(", ");
  const out: string[] = [];
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    if (out.length >= 10) break;
    if (element.getClientRects().length === 0 || getComputedStyle(element).visibility === "hidden") continue;
    let entry: string;
    const control = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
    if (control && element.getAttribute("aria-invalid") === "true") {
      const name = element.getAttribute("name") || element.id || element.closest("[data-field-path]")?.getAttribute("data-field-path") || "";
      entry = `invalid control: ${name}`;
    } else {
      entry = (element.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    }
    if (entry && !out.includes(entry)) out.push(entry);
  }
  return out;
}
