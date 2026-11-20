import { atsKindNeedsApproval, type AtsClassification, type AtsKind, type AtsSignal } from "@internship-agent/domain";

type ScoredKind = { kind: AtsKind; confidence: number; signals: AtsSignal[] };

type AdapterSignals = {
  kind: Exclude<AtsKind, "unknown">;
  url: RegExp[];
  title: RegExp[];
  body: RegExp[];
};

/**
 * Deterministic ATS signal tables. Each adapter declares the URL, title,
 * and body patterns that identify it; classification scores all three and
 * picks the strongest. Weights keep a bare URL match from deciding alone:
 * a confident call needs corroboration from the page itself.
 */
const ADAPTERS: AdapterSignals[] = [
  {
    kind: "greenhouse",
    url: [/boards\.greenhouse\.io/i, /greenhouse\.io/i, /gh_jid=/i],
    title: [/greenhouse/i],
    body: [/greenhouse/i, /gh_jid/i, /boards\.greenhouse/i]
  },
  {
    kind: "lever",
    url: [/lever\.co/i, /jobs\.lever\.co/i],
    title: [/lever/i],
    body: [/lever\.co/i, /lever-/i, /posting-requirements/i]
  },
  {
    kind: "workday",
    url: [/myworkdayjobs\.com/i, /workday/i, /\.wd\d+\.myworkdayjobs/i],
    title: [/workday/i, /careers/i],
    body: [/workday/i, /wd-\d+/i, /candidate home/i]
  },
  {
    kind: "handshake",
    url: [/joinhandshake\.com/i, /app\.joinhandshake\.com/i],
    title: [/handshake/i],
    body: [/handshake/i, /join handshake/i]
  },
  {
    // Oracle Cloud HCM Candidate Experience. No bare /oracle/ body pattern:
    // postings mention Oracle databases.
    kind: "oracle",
    url: [/\.oraclecloud\.com\//i, /\/hcmUI\/CandidateExperience\//i],
    title: [/candidate experience/i],
    body: [/hcmUI\/CandidateExperience/i, /oraclecloud\.com/i]
  },
  {
    kind: "smartrecruiters",
    url: [/jobs\.smartrecruiters\.com/i, /smartrecruiters\.com/i],
    title: [/smartrecruiters/i],
    body: [/smartrecruiters/i]
  },
  {
    // jobs.ashbyhq.com/<company>/<id>/application is one page, filled like Greenhouse.
    // Embedded forms carry ?ashby_jid=; the page text only says "Powered by" beside Ashby's logo.
    kind: "ashby",
    url: [/jobs\.ashbyhq\.com/i, /ashbyhq\.com/i, /[?&]ashby_jid=/i],
    title: [/ashby/i],
    body: [/ashbyhq/i, /powered by ashby/i]
  },
  {
    kind: "jobvite",
    url: [/jobs\.jobvite\.com/i, /\.jobvite\.com\//i],
    title: [/jobvite/i],
    body: [/powered by jobvite/i, /jobvite/i]
  },
  {
    kind: "icims",
    url: [/\.icims\.com\//i],
    title: [/icims/i],
    body: [/powered by icims/i, /\bicims\b/i]
  },
  {
    // Dover's one-page form at app.dover.io/apply/job/<id>. app.dover.io application links redirect to
    // jobs.dover.com/job/<id>, and classification reads the current page's URL (browser-orchestrator.ts).
    // No title pattern: Dover Corporation names other sites' postings.
    kind: "dover",
    url: [/app\.dover\.io/i, /jobs\.dover\.com/i, /\bdover\.(?:io|com)\//i],
    title: [],
    body: [/powered by dover/i, /app\.dover\.io/i, /jobs\.dover\.com/i, /agree to dover['’]s terms/i]
  },
  {
    // Rippling Recruiting at ats.rippling.com/<board>/jobs/<id>. No title pattern: postings name Rippling the company.
    kind: "rippling",
    url: [/ats\.rippling\.com/i, /rippling\.com/i],
    title: [],
    body: [/powered by rippling/i, /ats\.rippling\.com/i]
  }
];

/** At or above this confidence the run proceeds without asking. */
export const ATS_AUTO_THRESHOLD = 0.6;
/** At or above this the candidate confirms; below it the generic flow waits. */
export const ATS_CONFIRM_THRESHOLD = 0.3;

export function classifyAts(url: string, title: string, bodyText: string): AtsClassification {
  const scored: ScoredKind[] = ADAPTERS.map((adapter) => {
    const signals: AtsSignal[] = [];
    for (const pattern of adapter.url) {
      if (pattern.test(url)) signals.push({ source: "url", pattern: String(pattern), weight: 0.5 });
    }
    for (const pattern of adapter.title) {
      if (pattern.test(title)) signals.push({ source: "title", pattern: String(pattern), weight: 0.35 });
    }
    const body = bodyText.slice(0, 20_000);
    for (const pattern of adapter.body) {
      if (pattern.test(body)) signals.push({ source: "body", pattern: String(pattern), weight: 0.4 });
    }
    const confidence = Math.min(1, signals.reduce((total, signal) => total + signal.weight, 0));
    return { kind: adapter.kind, confidence, signals };
  });
  scored.sort((a, b) => b.confidence - a.confidence);
  const best = scored[0];
  if (!best || best.confidence < ATS_CONFIRM_THRESHOLD) {
    return { kind: "unknown", confidence: best?.confidence ?? 0, signals: best?.signals ?? [] };
  }
  return best;
}

export type AtsFlow = "auto" | "confirm" | "generic";

export function atsFlowFor(classification: AtsClassification): AtsFlow {
  if (classification.kind === "unknown") return "generic";
  // Recognized for display only: the candidate approves each run (domain ats.ts).
  if (atsKindNeedsApproval(classification.kind)) return "confirm";
  if (classification.confidence >= ATS_AUTO_THRESHOLD) return "auto";
  return "confirm";
}
