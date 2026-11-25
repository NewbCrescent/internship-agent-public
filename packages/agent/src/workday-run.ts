import type { DatabaseSync } from "node:sqlite";

import { saveBrowserSession } from "@internship-agent/db";
import {
  hasTranscriptField,
  planAutofill,
  walkWorkdayApplication,
  WorkdayAccountWall,
  type WorkdayHistoryOptions,
  type FieldResolution,
  type StandingInputs,
  type WorkdayPage,
  type WorkdayStep,
  type WorkdayStepPlan,
  type WorkdayWalkResult
} from "@internship-agent/browser";
import {
  parseWorkdayUrl,
  workdaySiteKey,
  type ApplicationProfile,
  type Candidate,
  type FillDecision,
  type JobPosting,
  type PauseRecord,
  type RecognizedForm
} from "@internship-agent/domain";

import { yearHoldMessage } from "./company-policy";
import { answeredPauseDecision } from "./question-answers";
import { AutomaticRunStopped, WorkdayAccountHeld, WorkdaySignInRequired } from "./run-errors";
import { ensureWorkdayAccount, type WorkdayAccountRuntime } from "./workday-account-service";
import type { VoiceDrafter } from "./voice-drafting";
import { applyVoiceDrafts, draftSourcesFor } from "./voice-drafting";

/** Orchestrator helpers the Workday run reuses, passed in to keep one source of truth. */
export type WorkdayRunDeps = {
  /**
   * `transcript`: the form asked for a transcript, so answers come from the alternate (2029) profile.
   * `employerSite`: the Workday tenant of the application address (the employer that runs the form), for previous-employment questions.
   */
  resolveFields(form: RecognizedForm, transcript: boolean, employerSite: string | null): Promise<Map<string, FieldResolution>>;
  uploadsFor(decisions: FillDecision[], transcript: boolean): Promise<(decision: FillDecision) => string | null>;
  /** Points resume uploads at the candidate's uploaded resume for the profile, when the run sends one. */
  chooseResume(decisions: FillDecision[], transcript: boolean): FillDecision[];
};

export type WorkdayRunContext = {
  database: DatabaseSync;
  candidateId: string;
  posting: JobPosting;
  candidate: Candidate | null;
  packageAnswers: Array<{ prompt: string; text: string }>;
  variantId: string | null;
  drafter: VoiceDrafter | null;
  /** Answers the candidate gave to earlier pauses, by step-prefixed field id. */
  answers: Map<string, string>;
  /** Work and education rows for My Experience, for the default and the transcript profile. */
  history: WorkdayHistoryOptions | null;
  /** The run already switched to the alternate profile on an earlier walk. */
  transcript: boolean;
  /** The stored transcript's id, when the candidate uploaded one. */
  transcriptDocumentId(): string | null;
  deps: WorkdayRunDeps;
  jobId: string;
  /** Account automation for this run (automatic runs only); null keeps the candidate's own sign-in. */
  account: { runtime: WorkdayAccountRuntime; mode: "create" | "sign-in" } | null;
  /** The company's pinned profile; "default" holds a step that asks for a transcript. */
  profileLock?: ApplicationProfile | null;
  /** The candidate's standing consent and attestation settings for this run. */
  standing?: StandingInputs;
};

export { WorkdaySignInRequired };

/**
 * Opens the application and walks it. `fill` stops at Review (or at the first
 * step needing the candidate); `submit` clicks Submit on Review and must only
 * be used with the candidate's recorded approval.
 */
export async function walkWorkday(
  page: WorkdayPage,
  applicationUrl: string,
  context: WorkdayRunContext,
  mode: "fill" | "submit",
  confirm?: (page: WorkdayPage) => Promise<string>
): Promise<WorkdayWalkResult> {
  const location = parseWorkdayUrl(applicationUrl);
  const company = context.posting.companyName;
  let signedIn = false;
  const signIn = async (): Promise<"flow"> => {
    signedIn = true;
    if (!context.account) {
      if (location) {
        saveBrowserSession(context.database, {
          site: workdaySiteKey(location), status: "signed_out", checkedAt: new Date().toISOString(),
          detail: `A browser run found ${company}'s Workday signed out. Open sign-in on the Workday accounts page.`
        });
      }
      throw new WorkdaySignInRequired(`${company}'s Workday asks you to sign in. Use Open sign-in on the Workday accounts page; the pipeline retries this application afterwards.`);
    }
    // Automatic runs with the account opt-in sign in (or create the account) themselves.
    await ensureWorkdayAccount(page, {
      database: context.database, jobId: context.jobId, applicationUrl, company, candidateEmail: context.candidate?.email,
      runtime: context.account.runtime, mode: context.account.mode
    });
    const again = await page.enterApplication();
    if (again !== "flow" || await page.signInRequired()) {
      throw new WorkdayAccountHeld(`Workday ${location?.host ?? "site"}: the application did not open after signing in.`);
    }
    return again;
  };
  let entered = await page.enterApplication();
  if (entered === "sign-in" || await page.signInRequired()) entered = await signIn();
  // A missing Apply button usually means the posting closed: a real stop.
  if (entered === "missing") throw new AutomaticRunStopped(`No Workday application opened at ${applicationUrl}; the posting may be closed.`);
  const walk = () => walkWorkdayApplication(page, (step, form, state) => planWorkdayStep(step, form, context, state.transcript, location?.tenant ?? null), {
    mode, confirm, history: context.history ?? undefined, transcript: context.transcript
  });
  try {
    return await walk();
  } catch (error) {
    // The account screen showed up inside the walk (a real site drew it late): sign in once, then walk again.
    if (!(error instanceof WorkdayAccountWall)) throw error;
    const held = new WorkdayAccountHeld(`Workday ${location?.host ?? "site"}: the application still shows the account screen after signing in.`);
    if (signedIn) throw held;
    await signIn();
    try {
      return await walk();
    } catch (again) {
      throw again instanceof WorkdayAccountWall ? held : again;
    }
  }
}

async function planWorkdayStep(
  step: WorkdayStep,
  form: RecognizedForm,
  context: WorkdayRunContext,
  transcript: boolean,
  employerSite: string | null
): Promise<WorkdayStepPlan> {
  const candidate = context.candidate;
  if (context.profileLock === "default" && hasTranscriptField(form.fields)) {
    throw new AutomaticRunStopped(yearHoldMessage(context.database, context.candidateId, context.posting.companyName));
  }
  const transcriptDocumentId = transcript ? context.transcriptDocumentId() : null;
  // The document is needed only on a step that asks for it (a run pinned to the transcript profile may have none).
  if (transcript && !transcriptDocumentId && hasTranscriptField(form.fields)) {
    throw new AutomaticRunStopped(`${context.posting.companyName}'s Workday application asks for your transcript. Upload it on the profile page, then start the run again.`);
  }
  const plan = planAutofill(form, {
    profile: {
      email: candidate?.email, phone: candidate?.phone, portfolioUrl: candidate?.portfolioUrl,
      fullName: candidate?.fullName, linkedinUrl: candidate?.linkedinUrl, githubUrl: candidate?.githubUrl,
      legalFirstName: candidate?.legalFirstName, legalLastName: candidate?.legalLastName,
      addressLine1: candidate?.addressLine1, addressLine2: candidate?.addressLine2, addressCity: candidate?.addressCity,
      addressRegion: candidate?.addressRegion, addressPostalCode: candidate?.addressPostalCode, addressCountry: candidate?.addressCountry,
      phoneType: candidate?.phoneType, fieldOfStudy: candidate?.fieldOfStudy, gpa: candidate?.gpa
    },
    resolutions: await context.deps.resolveFields(form, transcript, employerSite),
    packageAnswers: context.packageAnswers,
    variantId: context.variantId,
    transcriptDocumentId,
    standing: context.standing
  });
  let { decisions, pauses } = applyAnswers(step, form, plan.decisions, plan.pauses, context.answers);
  if (context.drafter) {
    ({ decisions, pauses } = await applyVoiceDrafts({ decisions, pauses }, form, {
      drafter: context.drafter, posting: context.posting, sources: draftSourcesFor(context.database, context.candidateId)
    }));
  }
  decisions = context.deps.chooseResume(decisions, transcript);
  return { decisions, pauses, safeguardHalt: plan.safeguardHalt, uploadPathFor: await context.deps.uploadsFor(decisions, transcript) };
}

/**
 * Turns the candidate's answers to earlier pauses into fills for this step:
 * a pause on the field itself, or a Workday error pause on it
 * (`workday-error::<field>`), which answers the field whatever the planner
 * decided (except a row removal), since Workday said the field needs it.
 */
function applyAnswers(
  step: WorkdayStep,
  form: RecognizedForm,
  decisions: FillDecision[],
  pauses: PauseRecord[],
  answers: Map<string, string>
): { decisions: FillDecision[]; pauses: PauseRecord[] } {
  const fields = new Map(form.fields.map((field) => [field.id, field]));
  const answered = new Map<string, string>();
  const next = decisions.map((decision): FillDecision => {
    const field = fields.get(decision.fieldId);
    if (!field) return decision;
    const answer = decision.action === "pause" ? answers.get(`${step.name}::${decision.fieldId}`) : undefined;
    const value = answer ?? (decision.action === "remove" ? undefined : answers.get(`${step.name}::workday-error::${decision.fieldId}`));
    if (value === undefined) return decision;
    const filled = answeredPauseDecision(field, value, null);
    if (filled) answered.set(decision.fieldId, value);
    return filled ?? decision;
  });
  return {
    decisions: next,
    pauses: pauses.map((pause) => (answered.has(pause.fieldId) ? { ...pause, status: "answered" as const, answer: answered.get(pause.fieldId) ?? null } : pause))
  };
}

/** Workday's validation errors become one pause when Workday showed no error the run could name (workdayErrorPauses makes the rest). */
export function blockedPause(step: string, errors: string[]): PauseRecord {
  const question = `Workday could not save ${step}: ${errors.join(" ")}`.slice(0, 500);
  return {
    fieldId: `${step}::workday-errors`, label: `${step} (Workday errors)`, question, suggestedKey: null, suggestedScope: null,
    safeguard: false, sensitive: false, upload: false, status: "open", answer: null, draft: null
  };
}
