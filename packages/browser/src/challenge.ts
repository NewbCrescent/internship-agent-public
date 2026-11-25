import type { FillDecision, PauseRecord } from "@internship-agent/domain";

import type { PostSubmitEvidence } from "./submission-outcome";

/**
 * Visible CAPTCHA challenges, read from the DOM only. Detection never clicks,
 * types, opens a frame, solves, injects a token, hides automation, or changes
 * the browser's fingerprint. The hidden token field (`g-recaptcha-response`
 * and its hCaptcha/Turnstile siblings) and the invisible, v3, or Enterprise
 * reCAPTCHA badge are page machinery: the browser submits normally and the
 * site's own scoring decides. Only a challenge the candidate would see pauses
 * the run: a reCAPTCHA checkbox or image challenge, an hCaptcha or Turnstile
 * widget, a DataDome page, or a human-verification page. Turnstile's frame
 * sits in a closed shadow root, so the Playwright page also reads the browser's
 * frame tree for it (only the frame's address and its element's box; never
 * inside the frame).
 */
export type VisibleChallenge = { kind: "recaptcha" | "hcaptcha" | "turnstile" | "challenge-page"; detail: string };

/** Names and ids of the hidden CAPTCHA token fields; never a question. */
export const CAPTCHA_TOKEN_NAME = /^(?:g-recaptcha-response|h-captcha-response|cf-turnstile-response)(?:-\d+)?$/i;

export function isCaptchaTokenControl(control: { name?: string; id?: string }): boolean {
  return CAPTCHA_TOKEN_NAME.test(control.name ?? "") || CAPTCHA_TOKEN_NAME.test(control.id ?? "");
}

/**
 * Whether a frame address is Cloudflare Turnstile's challenge frame. Turnstile
 * draws that frame inside a closed shadow root (since 2024), which the in-page
 * read below never reaches, so the Playwright page reads the browser's frame
 * tree for it (handshake-executor.ts).
 */
export function isTurnstileFrameSource(source: string): boolean {
  try {
    return new URL(source).hostname.toLowerCase() === "challenges.cloudflare.com";
  } catch {
    return false;
  }
}

/**
 * Runs inside the page (passed to `page.evaluate` directly), so it is
 * self-contained: every helper and pattern is declared here. Reads the
 * global `document`.
 */
export function findVisibleChallengeIn(): VisibleChallenge | null {
  const shown = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20 || rect.bottom <= 0 || rect.right <= 0) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
    }
    return true;
  };
  for (const frame of Array.from(document.querySelectorAll("iframe"))) {
    if (!shown(frame)) continue;
    const src = frame.getAttribute("src") ?? "";
    const title = frame.getAttribute("title") ?? "";
    if (/\/recaptcha\/(?:api2|enterprise)\/anchor/i.test(src)) {
      // The invisible / v3 / Enterprise badge is not a challenge.
      if (/[?&#]size=invisible\b/i.test(src)) continue;
      return { kind: "recaptcha", detail: "a reCAPTCHA checkbox" };
    }
    if (/\/recaptcha\/(?:api2|enterprise)\/bframe/i.test(src) || /recaptcha challenge/i.test(title)) {
      return { kind: "recaptcha", detail: "a reCAPTCHA image challenge" };
    }
    if (/hcaptcha\.com/i.test(src)) return { kind: "hcaptcha", detail: "an hCaptcha challenge" };
    if (/challenges\.cloudflare\.com/i.test(src)) return { kind: "turnstile", detail: "a Cloudflare Turnstile challenge" };
    if (/captcha-delivery\.com/i.test(src) || /datadome/i.test(title)) return { kind: "challenge-page", detail: "a DataDome CAPTCHA page" };
  }
  const text = (document.body?.innerText ?? "").slice(0, 5_000);
  if (/\b(?:verify (?:that )?you are (?:a )?human|checking (?:if the site connection is secure|your browser)|press (?:and|&) hold)\b/i.test(text)) {
    return { kind: "challenge-page", detail: "a human-verification page" };
  }
  return null;
}

/**
 * A submission the agent stopped short of calling submitted, and holds for
 * the candidate. A hold after the submit click carries what the page showed
 * (submission-outcome.ts); one before the click carries none.
 */
export class SubmissionHeld extends Error {
  readonly evidence: PostSubmitEvidence | null;
  constructor(message: string, evidence: PostSubmitEvidence | null = null) {
    super(message);
    this.evidence = evidence;
  }
}
/** A visible challenge appeared around the submit click. */
export class SubmissionChallenged extends SubmissionHeld {}
/** The site showed an error instead of a confirmation. */
export class SubmissionRefused extends SubmissionHeld {}

export const CHALLENGE_FIELD_ID = "site-challenge";

/** The safeguard pause a visible challenge adds to a run; safeguard runs are never submitted. */
export function challengePause(challenge: VisibleChallenge): { decision: FillDecision; pause: PauseRecord } {
  const question = `The application shows ${challenge.detail}. The agent never solves CAPTCHAs; finish this application yourself in your browser.`;
  return {
    decision: {
      fieldId: CHALLENGE_FIELD_ID,
      action: "pause",
      value: null,
      basis: null,
      reason: question,
      pause: { question, key: null, scope: null, safeguard: true }
    },
    pause: {
      fieldId: CHALLENGE_FIELD_ID,
      label: "Visible CAPTCHA challenge",
      question,
      suggestedKey: null,
      suggestedScope: null,
      safeguard: true,
      sensitive: false,
      upload: false,
      status: "open",
      answer: null,
      draft: null
    }
  };
}
