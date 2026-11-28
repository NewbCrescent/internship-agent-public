import type { AtsKind } from "@internship-agent/domain";

/**
 * Ashby's own submit feedback. Ashby saves each answer to its server as it is
 * set and refuses a submit click while a save is still running: it shows the
 * toast "We're updating your application (e.g. uploading files), please try
 * again when they're finished." and sends nothing; the toast is removed when
 * the save ends. A refused submission (its reCAPTCHA Enterprise spam check,
 * or any server error) leaves `.ashby-application-form-failure-container`.
 *
 * Source: Ashby's public front-end bundle (index-CY3T4pnC.js, read
 * 2026-11-24, no submission made) and the 2026-11-25 Contoro run <run id>.
 * Everything here reads the DOM only and never touches reCAPTCHA.
 */

/** Wait before the first click: Ashby's 500 ms text-save debounce plus a save round trip. */
export const ASHBY_SAVE_SETTLE_MS = 2_000;
/** Wait before a click made again after Ashby's busy notice has gone. */
export const ASHBY_RECLICK_SETTLE_MS = 1_000;
/** At most this many submit clicks on one Ashby page. */
export const ASHBY_MAX_SUBMIT_CLICKS = 3;

/** True for an Ashby-hosted page (`ashbyhq.com` or a subdomain). */
export function isAshbyApplicationUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "ashbyhq.com" || host.endsWith(".ashbyhq.com");
  } catch {
    return false;
  }
}

/**
 * Ashby by its recognized ATS kind or its host. Embedded `ashby_jid` pages draw
 * the form in an iframe the agent does not read, so they are not special-cased.
 */
export function isAshbyApplication(url: string, atsKind?: AtsKind | null): boolean {
  return atsKind === "ashby" || isAshbyApplicationUrl(url);
}

/** Ashby's "still saving" toast (single form: "application"; multi-form: "forms"). */
export const ASHBY_BUSY_NOTICE = /we['’]re updating your (?:application|forms?)\b[\s\S]{0,80}?please try again when they['’]re finished/i;

export function isAshbyBusyNotice(text: string): boolean {
  return ASHBY_BUSY_NOTICE.test(text);
}

/** Ashby's spam-check failure pane and its CAPTCHA error toast. */
export const ASHBY_SPAM_CHECK = /legitimate applications are occasionally flagged by mistake|problem verifying this submission with captcha/i;

export function isAshbySpamCheck(text: string): boolean {
  return ASHBY_SPAM_CHECK.test(text);
}

export type AshbySubmitState = {
  /** Ashby's busy notice appeared since the last settle. */
  busySeen: boolean;
  /** Ashby's busy notice is shown now. */
  busyShown: boolean;
  /** Text of Ashby's visible failure container; empty when none. */
  failureText: string;
  /** The failure is Ashby's spam check (or its CAPTCHA error toast). */
  spamCheck: boolean;
};

export const EMPTY_ASHBY_SUBMIT_STATE: AshbySubmitState = { busySeen: false, busyShown: false, failureText: "", spamCheck: false };

export type AshbySubmitStep = "wait" | "click-again" | "refused" | "spam-check";

/**
 * What the submit wait does next on Ashby. A click is made again only when
 * Ashby's busy notice showed (that click sent nothing) and has gone, and only
 * up to ASHBY_MAX_SUBMIT_CLICKS; a failure container is never clicked again.
 */
export function nextAshbyStep(state: AshbySubmitState, clicks: number): AshbySubmitStep {
  if (state.spamCheck) return "spam-check";
  if (state.failureText.trim()) return "refused";
  if (state.busySeen && !state.busyShown && clicks < ASHBY_MAX_SUBMIT_CLICKS) return "click-again";
  return "wait";
}

export const ASHBY_SPAM_CHECK_DETAIL = "Ashby's spam check (reCAPTCHA Enterprise)";

export const ASHBY_SPAM_CHECK_MESSAGE =
  "After the submit click Ashby's spam check (reCAPTCHA Enterprise) refused the submission. The agent never works around a bot check or solves CAPTCHAs, so this is the only step left for you: check this application in your own browser and finish it there. The run is not marked submitted.";

export const ASHBY_BUSY_DETAIL = "Ashby showed its \"We're updating your application\" notice at the last submit click, so that click sent nothing.";

export function ashbyBusyMessage(clicks: number): string {
  return `Ashby was still saving the answers at each of the ${clicks} submit click(s) ("We're updating your application … please try again when they're finished"), so nothing was sent. The run is not marked submitted; check the application on the site before retrying.`;
}

type AshbyWatch = { __iaAshbySubmit?: { busySeen: boolean; observer: MutationObserver | null } };

/**
 * In-page (page.evaluate): starts a fresh watch for Ashby's busy notice, then
 * blurs the focused field so a debounced text save starts now rather than on
 * the click's mousedown. Self-contained: everything it uses is declared here.
 */
export function watchAshbySubmitFeedbackIn(): void {
  const busy = /we['’]re updating your (?:application|forms?)\b[\s\S]{0,80}?please try again when they['’]re finished/i;
  const holder = window as unknown as AshbyWatch;
  holder.__iaAshbySubmit?.observer?.disconnect();
  const watch: { busySeen: boolean; observer: MutationObserver | null } = { busySeen: false, observer: null };
  holder.__iaAshbySubmit = watch;
  if (document.body) {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") {
          if (busy.test(record.target.textContent ?? "")) watch.busySeen = true;
          continue;
        }
        for (const node of Array.from(record.addedNodes)) {
          if (busy.test(node.textContent ?? "")) watch.busySeen = true;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    watch.observer = observer;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
}

/** In-page (page.evaluate): Ashby's busy notice and failure container. Self-contained. */
export function readAshbySubmitStateIn(): AshbySubmitState {
  const busy = /we['’]re updating your (?:application|forms?)\b[\s\S]{0,80}?please try again when they['’]re finished/i;
  const spam = /legitimate applications are occasionally flagged by mistake|problem verifying this submission with captcha/i;
  const body = document.body?.innerText ?? "";
  const busyShown = busy.test(body);
  const seen = (window as unknown as AshbyWatch).__iaAshbySubmit?.busySeen ?? false;
  const failureText = Array.from(
    document.querySelectorAll<HTMLElement>(".ashby-application-form-failure-container, .ashby-application-form-blocked-application-container")
  )
    .filter((element) => element.getClientRects().length > 0)
    .map((element) => (element.innerText ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 600);
  return { busySeen: seen || busyShown, busyShown, failureText, spamCheck: spam.test(failureText) || spam.test(body) };
}
