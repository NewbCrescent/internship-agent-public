import {
  ASHBY_BUSY_DETAIL,
  ASHBY_BUSY_NOTICE,
  ASHBY_RECAPTCHA_REJECTED,
  isAshbyApplicationUrl,
  isAshbySpamCheck,
  readConfirmationFromText
} from "@internship-agent/browser";
import type { BrowserRun } from "@internship-agent/domain";

import type { StoredSubmitEvidence } from "./submit-evidence";

/**
 * Judges one stored post-submit capture (evidence.json) as "the site never
 * took the submit", or says exactly why not. Pure: no database, no network,
 * no model. Used by `pnpm pipeline:retry --reopen-unsubmitted` and
 * `--correct-submitted` (automatic-retry.ts).
 *
 * Accepted, deterministically:
 * - Ashby's busy notice recorded at the last submit click (ASHBY_BUSY_DETAIL,
 *   Track 16): Ashby sent nothing for that click;
 * - Dover's Cloudflare Turnstile recorded as the challenge (Track 10);
 * - an older capture (outcome "unknown", no detail) on an Ashby or Dover
 *   application page that still shows the filled form (the uploaded resume
 *   above the submit control), with, on Dover, a Turnstile marker in its text.
 * Every capture must be on the run's own application page and show no
 * confirmation, failure, correction, invalid field, or other challenge, and
 * still show the submit control. Anything else is refused with the signal
 * that is missing.
 *
 * An Ashby capture with a network record (Track 22) is refused when the record
 * shows Ashby's reCAPTCHA rejection (a bot check is never retried), Ashby's
 * server accepting the submission, its application-limit block message, or
 * any submit request whose answer does not show that Ashby refused it; a
 * record with no submit request, or only submits Ashby answered with field
 * errors, goes on to the checks above.
 */

/** The challenge detail challenge.ts and handshake-executor.ts record for a shown Turnstile frame (greenhouse-fixture-run.ts asserts it). */
export const TURNSTILE_CHALLENGE_DETAIL = "a Cloudflare Turnstile challenge";

export type NeverTakenKind = "ashby-busy-evidence" | "dover-turnstile-evidence" | "intact-form-evidence";

export const NEVER_TAKEN_TEXT: Record<NeverTakenKind, string> = {
  "ashby-busy-evidence": "its post-submit evidence shows Ashby's \"We're updating your application\" notice at the last submit click, with the form still shown",
  "dover-turnstile-evidence": "its post-submit evidence shows Dover's unchecked Cloudflare Turnstile with the form still shown",
  "intact-form-evidence": "its post-submit evidence shows the filled form still on the application page with its submit control, and no confirmation, error, or challenge"
};

export type CaptureVerdict = { kind: NeverTakenKind; text: string } | { refusal: string };

type Capture = Pick<StoredSubmitEvidence, "outcome" | "url" | "invalidFields" | "alertText" | "challenge" | "text" | "detail">
  & Partial<Pick<StoredSubmitEvidence, "ashbyNetwork">>;

const DOVER_APPLY_PATH = /^\/apply\/job\/([0-9a-f-]{36})$/i;
const DOVER_JOB_PATH = /^\/job\/([0-9a-f-]{36})$/i;

/**
 * The application page a URL names: Dover's app.dover.io/apply/job/<uuid>
 * and its jobs.dover.com/job/<uuid> redirect share one key; any other page is
 * keyed by protocol, host, and path (no query, hash, or trailing slash).
 */
export function applicationPageKey(url: string): string | null {
  const parsed = URL.parse(url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "");
  const dover = host === "app.dover.io" ? DOVER_APPLY_PATH.exec(path) : host === "jobs.dover.com" ? DOVER_JOB_PATH.exec(path) : null;
  if (dover) return `dover:${dover[1]!.toLowerCase()}`;
  return `${parsed.protocol}//${host}${path}`;
}

export function sameApplicationPage(runUrl: string, evidenceUrl: string): boolean {
  const run = applicationPageKey(runUrl);
  const evidence = applicationPageKey(evidenceUrl);
  return run !== null && evidence !== null && run === evidence;
}

/** The site whose never-taken rules apply, by both URLs; null for any other site. */
export function captureSite(runUrl: string, evidenceUrl: string): "ashby" | "dover" | null {
  if (isAshbyApplicationUrl(runUrl) && isAshbyApplicationUrl(evidenceUrl)) return "ashby";
  const run = applicationPageKey(runUrl);
  const evidence = applicationPageKey(evidenceUrl);
  if (run?.startsWith("dover:") && evidence?.startsWith("dover:")) return "dover";
  return null;
}

/** A closed-posting page ("The job you are looking for is no longer open." on Greenhouse, and similar). */
export const CLOSED_POSTING_TEXT = /\b(?:the job you are looking for is no longer open|this job is no longer (?:open|available|accepting applications)|this (?:position|posting|job) (?:has been filled|is closed|has closed|is no longer available)|no longer accepting applications)\b/i;

export function showsClosedPosting(capture: Pick<Capture, "text">): boolean {
  return CLOSED_POSTING_TEXT.test(capture.text);
}

/** Failure or correction text a site shows when it did not take a submit, or wants something fixed first. */
const FAILURE_TEXT = /\b(?:this field is required|(?:is|are) required(?=[.!])|please (?:fill|enter|select|complete|correct|fix|review|upload)|(?:is|are) (?:invalid|not valid)|invalid (?:email|phone|value|entry|input|format)|couldn['’]t submit|could not submit|unable to submit|failed to submit|submission failed|something went wrong|an error occurred|try again)\b/i;
const ASHBY_SUBMIT_LINE = /^submit application$/i;
const DOVER_SUBMIT_LINE = /^apply$/i;
const ASHBY_RESUME_LINE = /\.(?:pdf|docx?)$/i;
const ASHBY_REPLACE_LINE = /^replace$/i;
const DOVER_RESUME_LINE = /^Resume: .+\.(?:pdf|docx?)$/i;
const TURNSTILE_MARKER = /\bverify you are human\b/i;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Whether one capture shows the site never took the run's submit; the first missing signal otherwise. */
export function judgeSubmitCapture(run: Pick<BrowserRun, "applicationUrl">, capture: Capture): CaptureVerdict {
  const site = captureSite(run.applicationUrl, capture.url);
  if (site === null) return { refusal: "is read as never taken only on an Ashby or Dover application page" };

  // Ashby's network record (Track 22): what its server answered outranks what the page showed.
  const network = capture.ashbyNetwork ?? null;
  if (network !== null) {
    const submits = network.submits;
    if (submits.some((submit) => submit.errorCodes.includes(ASHBY_RECAPTCHA_REJECTED))) {
      return { refusal: "records Ashby's reCAPTCHA (spam check) rejection of the submit; the agent never retries a bot check" };
    }
    if (submits.some((submit) => submit.success)) return { refusal: "records Ashby's server accepting the submission" };
    if (submits.some((submit) => submit.blockMessage)) return { refusal: "records Ashby's application-limit block message" };
    const refusedWithErrors = (submit: (typeof submits)[number]) =>
      submit.resultType === "FormRender" && (submit.fieldErrors.length > 0 || submit.formErrorMessages.length > 0);
    if (submits.some((submit) => !refusedWithErrors(submit))) {
      return { refusal: "records a submit request whose answer does not show that Ashby refused it" };
    }
  }

  let kind: NeverTakenKind | "intact-form";
  if (capture.outcome === "unknown" && capture.detail === ASHBY_BUSY_DETAIL) {
    if (site !== "ashby") return { refusal: "carries Ashby's busy notice on a page that is not Ashby's" };
    kind = "ashby-busy-evidence";
  } else if (capture.outcome === "challenged" && capture.challenge === TURNSTILE_CHALLENGE_DETAIL) {
    if (site !== "dover") return { refusal: "shows a Turnstile challenge on a page other than Dover's, where it is not known to block the submit" };
    kind = "dover-turnstile-evidence";
  } else if (capture.outcome === "unknown" && capture.detail === null) {
    kind = "intact-form";
  } else if (capture.outcome === "challenged") {
    return { refusal: `shows a challenge other than Dover's Turnstile ("${clip(capture.challenge ?? "", 80)}")` };
  } else if (capture.outcome === "unknown") {
    return { refusal: "carries a detail other than Ashby's busy notice" };
  } else {
    return { refusal: `records the outcome "${capture.outcome}", which does not show that the site never took the submit` };
  }

  if (!sameApplicationPage(run.applicationUrl, capture.url)) return { refusal: "was captured at another address than the run's application page" };
  if (capture.invalidFields.length > 0) return { refusal: "lists fields the site marked invalid" };
  if (capture.alertText.trim() !== "") return { refusal: "shows the site's error text" };
  if (kind !== "dover-turnstile-evidence" && capture.challenge !== null) return { refusal: "shows a challenge" };
  const confirmation = readConfirmationFromText(capture.text);
  if (confirmation !== null) return { refusal: `shows confirmation text ("${clip(confirmation, 60)}")` };
  const withoutBusyNotice = capture.text.replace(new RegExp(ASHBY_BUSY_NOTICE.source, "gi"), "");
  if (FAILURE_TEXT.test(withoutBusyNotice) || isAshbySpamCheck(capture.text)) return { refusal: "shows failure or correction text" };

  const lines = capture.text.split("\n").map((line) => line.trim());
  const submitLine = site === "ashby" ? ASHBY_SUBMIT_LINE : DOVER_SUBMIT_LINE;
  let submitIndex = -1;
  lines.forEach((line, index) => { if (submitLine.test(line)) submitIndex = index; });
  if (submitIndex < 0) {
    return { refusal: `does not show the submit control ("${site === "ashby" ? "Submit Application" : "Apply"}") still on the form` };
  }

  if (kind === "intact-form") {
    const resumeIndex = site === "ashby"
      ? lines.findIndex((line, index) => ASHBY_RESUME_LINE.test(line) && ASHBY_REPLACE_LINE.test(lines[index + 1] ?? ""))
      : lines.findIndex((line) => DOVER_RESUME_LINE.test(line));
    if (resumeIndex < 0 || resumeIndex >= submitIndex) {
      return { refusal: "does not show the filled form (the uploaded resume above the submit control)" };
    }
    if (site === "ashby") {
      kind = "intact-form-evidence";
    } else {
      if (!TURNSTILE_MARKER.test(capture.text)) {
        return { refusal: "shows no Turnstile marker (Dover's widget draws its text inside a frame the capture cannot read, so the saved form alone does not show the click was refused)" };
      }
      kind = "dover-turnstile-evidence";
    }
  }
  return { kind, text: NEVER_TAKEN_TEXT[kind] };
}
