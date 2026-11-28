/**
 * Track 74: several-page forms on sites without an adapter, walked step by
 * step. Pure contracts (readStepProgress, steppedWalkEligible, the stepped
 * field ids, the auto-submit blocker) and walkSteppedForm against an
 * in-memory page; every host and value is fictional, and nothing touches a
 * browser or a database. The steps are modelled, not captured.
 */
import { describe, expect, it } from "vitest";

import {
  isSteppedRun,
  parseSteppedFieldId,
  autoSubmitBlockers,
  steppedFieldId,
  type BrowserField,
  type FillDecision,
  type PauseRecord,
  type RecognizedForm
} from "@internship-agent/domain";
import {
  readStepProgress,
  steppedWalkEligible,
  walkSteppedForm,
  type InvalidField,
  type RawControl,
  type SteppedPage,
  type SteppedStepPlan,
  type StepButtons
} from "@internship-agent/browser";

const HOST = "https://careers.fixturesteps.example";
const PHENOM_LIKE = `${HOST}/us/en/apply?jobSeqNo=R400004&step=1&stepname=personalInformation`;
const NEXT: StepButtons = { submit: false, next: "Next" };

describe("readStepProgress", () => {
  it("reads the step count from the page text, else the address", () => {
    expect(readStepProgress(`${HOST}/apply`, "Robotics Intern\nStep 1 of 5\nInformation")).toEqual({ index: 1, total: 5, source: "text" });
    expect(readStepProgress(`${HOST}/apply`, "STEP 2/4")).toEqual({ index: 2, total: 4, source: "text" });
    expect(readStepProgress(PHENOM_LIKE, "My Information")).toEqual({ index: 1, total: null, source: "url" });
    expect(readStepProgress(`${HOST}/apply?step=3`, "Step 2 of 4")).toEqual({ index: 2, total: 4, source: "text" });
  });

  it("reads nothing from an impossible count or address", () => {
    expect(readStepProgress(`${HOST}/apply`, "Step 6 of 5")).toBeNull();
    expect(readStepProgress(`${HOST}/apply`, "Step 0 of 3")).toBeNull();
    expect(readStepProgress(`${HOST}/apply?step=abc`, "")).toBeNull();
    expect(readStepProgress(`${HOST}/apply?step=0`, "")).toBeNull();
    expect(readStepProgress(`${HOST}/apply`, "Apply for this job")).toBeNull();
    expect(readStepProgress("not a url", "")).toBeNull();
  });
});

describe("steppedWalkEligible", () => {
  it("walks a Next-only page that shows a step count on a site without an adapter", () => {
    expect(steppedWalkEligible(PHENOM_LIKE, "My Information", NEXT)).toBe(true);
  });

  it("keeps the several-page stop everywhere else", () => {
    expect(steppedWalkEligible(PHENOM_LIKE, "", { submit: true, next: "Next" })).toBe(false);
    expect(steppedWalkEligible(PHENOM_LIKE, "", { submit: false, next: null })).toBe(false);
    expect(steppedWalkEligible(`${HOST}/apply`, "Apply", NEXT)).toBe(false);
    expect(steppedWalkEligible("https://fixture.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/1/apply/section/1?step=1", "", NEXT)).toBe(false);
    expect(steppedWalkEligible("https://fixture.wd5.myworkdayjobs.com/en-US/External/job/Fixture-City/Intern_R1/apply?step=1", "", NEXT)).toBe(false);
    expect(steppedWalkEligible("https://app.joinhandshake.com/apply/900001?step=1", "", NEXT)).toBe(false);
    expect(steppedWalkEligible("https://careers-fixture.icims.com/jobs/9001/intern/candidate?step=1", "", NEXT)).toBe(false);
  });
});

describe("stepped field ids and the auto-submit blocker", () => {
  it("round-trips a stepped id and tells stepped runs apart", () => {
    expect(steppedFieldId(2, "info.email")).toBe("step-2::info.email");
    expect(parseSteppedFieldId("step-2::info.email")).toEqual({ step: 2, id: "info.email" });
    expect(parseSteppedFieldId("step-12::a::b")).toEqual({ step: 12, id: "a::b" });
    expect(parseSteppedFieldId("My Information::email")).toBeNull();
    expect(parseSteppedFieldId("step-0::email")).toBeNull();
    expect(isSteppedRun({ decisions: [{ fieldId: "step-1::email" }] })).toBe(true);
    expect(isSteppedRun({ decisions: [{ fieldId: "email" }], pauses: [{ fieldId: "step-3::county" }] })).toBe(true);
    expect(isSteppedRun({ decisions: [{ fieldId: "My Information::email" }], pauses: [] })).toBe(false);
  });

  it("no longer holds a stepped run for being stepped (Track 80)", () => {
    const run = (fieldId: string) => ({
      status: "awaiting-approval", atsConfirmed: true, suggestedAtsKind: null, pauses: [],
      decisions: [
        { fieldId, action: "fill", basis: { kind: "profile" }, reason: "Profile email." },
        // Track 80: a stepped run needs application content (here its resume upload) to pass the content guard.
        { fieldId: fieldId.replace("email", "resume"), action: "upload", basis: { kind: "variant", variantId: "00000000-0000-4000-8000-000000000001" }, reason: "Resume." }
      ]
    });
    expect(autoSubmitBlockers(run("step-1::email"))).toEqual([]);
    expect(autoSubmitBlockers(run("email"))).toEqual([]);
  });
});

type FakeStep = {
  controls: RawControl[];
  buttons: StepButtons;
  url?: string;
  body?: string;
  /** Next marks these fields invalid and stays on the step. */
  invalidOnNext?: InvalidField[];
  /** Next does nothing. */
  stuck?: boolean;
};

/** An in-memory several-page form: Next moves an internal step counter; nothing touches a browser. */
function steppedPage(steps: FakeStep[]) {
  const state = { index: 0, nextClicks: 0, submitClicks: 0, invalid: [] as InvalidField[], filled: new Map<string, string>() };
  const current = () => steps[Math.min(state.index, steps.length - 1)]!;
  const page: SteppedPage = {
    url: () => current().url ?? `${HOST}/us/en/apply?jobSeqNo=R400004&step=${state.index + 1}`,
    title: async () => "Fixture Steps application",
    collectControls: async () => current().controls,
    bodyText: async () => current().body ?? "Fixture Steps application",
    fillField: async (field: BrowserField, value: string) => { state.filled.set(`${state.index + 1}:${field.id}`, value); },
    chooseOption: async (field: BrowserField, option: string) => { state.filled.set(`${state.index + 1}:${field.id}`, option); },
    setChecked: async (field: BrowserField, checked: boolean) => { state.filled.set(`${state.index + 1}:${field.id}`, String(checked)); },
    uploadFile: async () => {},
    clickSubmit: async () => { state.submitClicks += 1; },
    screenshot: async () => {},
    close: async () => {},
    invalidFields: async () => state.invalid,
    stepButtons: async () => current().buttons,
    clickStepNext: async (text: string) => {
      state.nextClicks += 1;
      const step = current();
      if (text !== step.buttons.next) return false;
      if (step.invalidOnNext) {
        state.invalid = step.invalidOnNext;
        return true;
      }
      if (step.stuck) return true;
      state.index += 1;
      return true;
    }
  };
  return { page, state };
}

const text = (id: string, label: string): RawControl => ({ tag: "input", type: "text", id, label, required: true });
const LAST: StepButtons = { submit: true, next: null };

/** Fills every field with a fictional value, except a field labelled "Unknown question", which pauses. */
function fillAll(seenForms: Array<{ step: number; form: RecognizedForm }> = []) {
  return async (step: number, form: RecognizedForm): Promise<SteppedStepPlan> => {
    seenForms.push({ step, form });
    const decisions: FillDecision[] = [];
    const pauses: PauseRecord[] = [];
    for (const field of form.fields) {
      if (field.label === "Unknown question") {
        const question = `Please answer "${field.label}".`;
        decisions.push({ fieldId: field.id, action: "pause", value: null, basis: null, reason: question, pause: { question, key: null, scope: null, safeguard: false } });
        pauses.push({
          fieldId: field.id, label: field.label, question, suggestedKey: null, suggestedScope: null,
          safeguard: false, sensitive: false, upload: false, status: "open", answer: null, draft: null
        });
      } else {
        decisions.push({ fieldId: field.id, action: "fill", value: `fixture ${field.id}`, basis: null, reason: "Fixture value.", pause: null });
      }
    }
    return { decisions, pauses, safeguardHalt: false };
  };
}

describe("walkSteppedForm", () => {
  it("walks to the last step, clicking only each step's Next, with step-prefixed ids", async () => {
    const { page, state } = steppedPage([
      { controls: [text("first", "First Name"), text("email", "Email Address")], buttons: NEXT },
      { controls: [text("city", "City")], buttons: NEXT },
      { controls: [text("note", "Anything else?")], buttons: LAST }
    ]);
    const walk = await walkSteppedForm(page, fillAll());
    expect(walk.outcome).toBe("last-page");
    expect(walk.steps).toEqual([1, 2, 3]);
    expect(walk.decisions.map((decision) => decision.fieldId)).toEqual(["step-1::first", "step-1::email", "step-2::city", "step-3::note"]);
    expect(walk.fieldLabels["step-2::city"]).toBe("City");
    expect(walk.last?.step).toBe(3);
    expect(state.nextClicks).toBe(2);
    expect(state.submitClicks).toBe(0);
    expect(state.filled.get("1:email")).toBe("fixture email");
    expect(state.filled.get("3:note")).toBe("fixture note");
  });

  it("holds a later step that shows Next but no step count", async () => {
    const { page, state } = steppedPage([
      { controls: [text("first", "First Name")], buttons: NEXT },
      { controls: [text("city", "City")], buttons: NEXT, url: `${HOST}/us/en/apply/more`, body: "More about you" }
    ]);
    const walk = await walkSteppedForm(page, fillAll());
    expect(walk.outcome).toBe("held");
    expect(walk.hold).toContain("no step count");
    expect(walk.steps).toEqual([1, 2]);
    expect(state.nextClicks).toBe(1);
    expect(state.submitClicks).toBe(0);
  });

  it("pauses on a field the site marks invalid after Next, with the site's error", async () => {
    const { page, state } = steppedPage([
      { controls: [text("first", "First Name")], buttons: NEXT },
      {
        controls: [text("pref", "Preferred Location")], buttons: NEXT,
        invalidOnNext: [{ ref: "pref", label: "Preferred Location", error: "This field is required." }]
      },
      { controls: [], buttons: LAST }
    ]);
    const walk = await walkSteppedForm(page, fillAll(), { settle: { timeoutMs: 1_500, pollMs: 20 } });
    expect(walk.outcome).toBe("paused");
    const pause = walk.pauses.find((entry) => entry.fieldId === "step-2::pref");
    expect(pause?.status).toBe("open");
    expect(pause?.question).toContain("This field is required.");
    expect(walk.decisions.find((decision) => decision.fieldId === "step-2::pref")?.action).toBe("pause");
    expect(state.nextClicks).toBe(2);
    expect(state.submitClicks).toBe(0);
  });

  it("holds a step that does not move on after Next", async () => {
    const { page } = steppedPage([{ controls: [text("first", "First Name")], buttons: NEXT, stuck: true }]);
    const walk = await walkSteppedForm(page, fillAll(), { settle: { timeoutMs: 300, pollMs: 20 } });
    expect(walk.outcome).toBe("held");
    expect(walk.hold).toContain("did not move on");
  });

  it("holds a step that shows both a submit control and Next", async () => {
    const { page, state } = steppedPage([{ controls: [text("first", "First Name")], buttons: { submit: true, next: "Next" } }]);
    const walk = await walkSteppedForm(page, fillAll());
    expect(walk.outcome).toBe("held");
    expect(walk.hold).toContain("shows both a submit control");
    expect(state.nextClicks).toBe(0);
    expect(state.submitClicks).toBe(0);
  });

  it("pauses on an open question without clicking Next", async () => {
    const { page, state } = steppedPage([
      { controls: [text("first", "First Name"), text("odd", "Unknown question")], buttons: NEXT },
      { controls: [], buttons: LAST }
    ]);
    const walk = await walkSteppedForm(page, fillAll());
    expect(walk.outcome).toBe("paused");
    expect(walk.pauses.map((pause) => pause.fieldId)).toEqual(["step-1::odd"]);
    expect(state.filled.get("1:first")).toBe("fixture first");
    expect(state.nextClicks).toBe(0);
  });

  it("never plans a field filled on an earlier step again", async () => {
    const forms: Array<{ step: number; form: RecognizedForm }> = [];
    const { page } = steppedPage([
      { controls: [text("email", "Email Address")], buttons: NEXT },
      { controls: [text("email", "Email Address"), text("city", "City")], buttons: LAST }
    ]);
    const walk = await walkSteppedForm(page, fillAll(forms));
    expect(walk.outcome).toBe("last-page");
    expect(forms[1]!.form.fields.map((field) => field.id)).toEqual(["city"]);
    expect(walk.decisions.map((decision) => decision.fieldId)).toEqual(["step-1::email", "step-2::city"]);
  });

  it("holds a step that asks for a password", async () => {
    const { page, state } = steppedPage([{ controls: [{ tag: "input", type: "password", id: "pw", label: "Password", required: true }], buttons: NEXT }]);
    const walk = await walkSteppedForm(page, fillAll());
    expect(walk.outcome).toBe("held");
    expect(walk.hold).toContain("password");
    expect(state.filled.size).toBe(0);
  });
});
