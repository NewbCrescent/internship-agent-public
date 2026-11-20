import type { AtsKind } from "@internship-agent/domain";

export type AdapterProfile = {
  kind: Exclude<AtsKind, "unknown">;
  /** What the adapter expects from the page before filling. */
  readiness: string[];
  /** Quirks the executor must respect rather than work around. */
  notes: string[];
  /** Multi-step flows pause with guidance instead of clicking through blind. */
  multipage: boolean;
};

/**
 * Per-ATS operating profiles. The initial supported flow is single-page
 * Greenhouse-, Lever-, and Ashby-pattern forms plus the generic Handshake flow;
 * Workday-pattern pages are recognized but pause: multi-step portals need
 * candidate eyes on every page turn. Oracle Cloud HCM and SmartRecruiters are
 * recognized for display only: no adapter walks their application, so the
 * candidate approves every run there. Jobvite and iCIMS are the same: a
 * data-consent step and an email-first account step stand in front of their
 * forms. Dover is one page filled by the generic filler; Rippling is
 * recognized for display only (a progress bar on its application page and no
 * success text the agent can recognize).
 */
export const ADAPTER_PROFILES: Record<AdapterProfile["kind"], AdapterProfile> = {
  greenhouse: {
    kind: "greenhouse",
    readiness: ["Boards or embedded Greenhouse form present", "Submit control labeled Apply or Submit"],
    notes: ["File inputs accept the prepared resume variant", "Custom questions pause when unmapped"],
    multipage: false
  },
  lever: {
    kind: "lever",
    readiness: ["Lever posting form present", "Full-profile and EEO sections may both appear"],
    notes: ["EEO fields are never autofilled", "LinkedIn/profile URLs pause unless the profile holds them"],
    multipage: false
  },
  workday: {
    kind: "workday",
    readiness: ["Workday application shell present"],
    notes: ["Multi-page portals pause at every page turn for candidate review", "Candidate Home account steps are never automated"],
    multipage: true
  },
  handshake: {
    kind: "handshake",
    readiness: ["Handshake application form present"],
    notes: ["The candidate's own persistent session carries authentication"],
    multipage: false
  },
  oracle: {
    kind: "oracle",
    readiness: ["Oracle Candidate Experience application present"],
    notes: ["Multi-step flow behind an email and one-time-code step; recognized for display only, the candidate approves each run"],
    multipage: true
  },
  smartrecruiters: {
    kind: "smartrecruiters",
    readiness: ["SmartRecruiters application page present"],
    notes: ["The posting page sits in front of a separate application page; recognized for display only, the candidate approves each run"],
    multipage: true
  },
  ashby: {
    kind: "ashby",
    readiness: ["Ashby application form present"],
    notes: ["Single-page form at /application; embedded forms on company sites sit in an iframe the agent does not read"],
    multipage: false
  },
  jobvite: {
    kind: "jobvite",
    readiness: ["Jobvite application page present after the posting's Apply link"],
    notes: ["A data-consent step (residence and language, then accept or decline) comes before the form; the agent never gives consent; recognized for display only, the candidate approves each run"],
    multipage: true
  },
  icims: {
    kind: "icims",
    readiness: ["iCIMS application page present after the posting's Apply link (the job sits in a same-site iframe)"],
    notes: ["Apply lands on an email-first account step (/login) before the form; the agent never creates iCIMS accounts; recognized for display only, the candidate approves each run"],
    multipage: true
  },
  dover: {
    kind: "dover",
    readiness: ["Dover application form present (app.dover.io/apply/job/<id>)", "Submit control labeled Apply"],
    notes: ["One page, filled by the generic filler"],
    multipage: false
  },
  rippling: {
    kind: "rippling",
    readiness: ["Rippling application page present (<posting>/apply, behind the posting's Apply now button)"],
    notes: ["The application page shows a progress bar and its success text is not known; recognized for display only, the candidate approves each run"],
    multipage: true
  }
};

export function adapterProfileFor(kind: AtsKind): AdapterProfile | null {
  if (kind === "unknown") return null;
  return ADAPTER_PROFILES[kind];
}
