import { describe, expect, it, vi } from "vitest";

import { promptSearchTerms, type EducationRow, type FillDecision } from "@internship-agent/domain";

import {
  absentDecisionFields,
  ashbyFieldPath,
  choicesNotTaken,
  formChangedPause,
  FORM_CHANGED_FIELD,
  ASHBY_ACCEPTED_CONFIRMATION,
  ASHBY_BLOCKED_MESSAGE,
  ASHBY_RECAPTCHA_REJECTED,
  ashbyFormErrorsMessage,
  ashbyGraphqlOperation,
  ashbyNetworkInvalidFields,
  ashbyNetworkVerdict,
  ashbySubmitSentAfter,
  createAshbyNetworkRecorder,
  isRecaptchaTokenRequest,
  readAshbySubmitResponse,
  readAshbySubmitToken,
  type AshbySubmitCall,
  type AshbySubmitNetwork,
  ASHBY_NOT_SENT_DETAIL,
  ashbyClickSentNothing,
  ashbyNotSentMessage,
  createAshbyDiagnosticsRecorder,
  diagnosticRequestTarget,
  sanitizeDiagnosticText,
  scrubValuesFrom,
  type AshbyClickCheck,
  type AshbySubmitDiagnostics,
  ASHBY_BUSY_DETAIL,
  ASHBY_MAX_SUBMIT_CLICKS,
  ASHBY_RECLICK_SETTLE_MS,
  ASHBY_SAVE_SETTLE_MS,
  ASHBY_SPAM_CHECK_DETAIL,
  isAshbyApplicationUrl,
  isAshbyBusyNotice,
  isAshbySpamCheck,
  nextAshbyStep,
  type AshbySubmitState,
  attachedNamesFromText,
  classifyFieldRole,
  classifyUploadRole,
  hasApplicationFields,
  hasTranscriptField,
  isChatbotControl,
  isSubmitControl,
  isTurnstileFrameSource,
  planAutofill,
  readConfirmationFromText,
  readNewConfirmation,
  submitAndConfirm,
  type BrowserPage,
  recognizeFields,
  recognizeForm,
  waitForStableControls,
  isHearAboutQuestion,
  isSafeguardField,
  matchCountryOption,
  chooseAnnouncementClose,
  type AnnouncementCandidate,
  matchSuggestion,
  pickHearAboutOption,
  stripRequiredMarker,
  unfilledPause,
  CONSENT_QUESTION,
  classifyUnconfirmed,
  isBenignAlertText,
  isRefusalAlert,
  invalidFieldPauses,
  isConfirmationUrl,
  isDialogCloseConfirmed,
  isDoverOrAshby,
  postSubmitEvidenceOf,
  readNewConfirmationUrl,
  stripUrlQuery,
  SubmissionChallenged,
  SubmissionHeld,
  SubmissionNeedsInput,
  SubmissionRefused,
  SubmissionUnconfirmed,
  isGreenhouseBoardUrl,
  isSecurityCodeStep,
  scrubSecret,
  SECURITY_CODE_STILL_ASKED,
  SecurityCodeNotEntered,
  securityCodeHoldMessage,
  SubmissionCodeNotFound,
  withoutSecret,
  type FieldResolution,
  type InvalidField,
  type PostSubmitEvidence,
  type RawControl,
  type SecurityCodeHoldKind,
  type SecurityCodeLookup,
  type SecurityCodeLookupResult,
  UNLABELED_CONTROL_LABEL
} from "@internship-agent/browser";

function control(partial: Partial<RawControl> & { tag: RawControl["tag"] }): RawControl {
  return partial;
}

describe("form recognition", () => {
  it("labels controls from aria, label, placeholder, then name", () => {
    const fields = recognizeFields([
      control({ tag: "input", type: "email", id: "e", label: "Email address", required: true }),
      control({ tag: "input", type: "text", name: "phone", placeholder: "Phone number" }),
      control({ tag: "textarea", name: "cover", label: "Cover letter" }),
      control({ tag: "select", name: "auth", label: "Work authorization", options: ["Yes", "No"] }),
      control({ tag: "input", type: "submit", label: "Submit application" }),
      control({ tag: "button", label: "Submit application" })
    ]);
    expect(fields.map((field) => [field.label, field.kind, field.required])).toEqual([
      ["Email address", "email", true],
      ["Phone number", "text", false],
      ["Cover letter", "textarea", false],
      ["Work authorization", "select", false]
    ]);
  });

  it("picks the terminal submit control and reads confirmations", () => {
    expect(isSubmitControl(control({ tag: "button", label: "Submit application" }))).toBe(true);
    expect(isSubmitControl(control({ tag: "button", label: "Save draft" }))).toBe(false);
    expect(readConfirmationFromText("Thank you! Your application was received.")).toContain("Thank you");
    expect(readConfirmationFromText("Please fix the errors below.")).toBe(null);
  });

  it("skips labels made only of invisible characters, and never uses a UUID name as a label (Dover)", () => {
    const fields = recognizeFields([
      control({ tag: "input", type: "text", name: "firstName", label: "\u200B", placeholder: "First name" }),
      control({ tag: "input", type: "text", name: "3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f", label: "\u200B\u200B" }),
      control({ tag: "input", type: "text", name: "question_3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f" }),
      control({ tag: "input", type: "email", name: "email", label: "Email\u200B *" }),
      control({ tag: "select", name: "visa", label: "Visa status", options: ["\u200B", "Citizen", "Visa holder"] })
    ]);
    expect(fields[0]!.label).toBe("First name");
    expect(fields[1]!.label).toMatch(UNLABELED_CONTROL_LABEL);
    expect(fields[2]!.label).toMatch(UNLABELED_CONTROL_LABEL);
    expect([fields[3]!.label, fields[3]!.required]).toEqual(["Email", true]);
    expect(fields[4]!.options).toEqual(["Citizen", "Visa holder"]);
  });

  it("keeps recognition pure and bounded", () => {
    const many: RawControl[] = Array.from({ length: 200 }, (_, index) => (
      control({ tag: "input", type: "text", name: `field-${index}`, label: `Field ${index}` })
    ));
    const form = recognizeForm("https://example.com/apply", "Apply", many);
    expect(form.fields.length).toBeLessThanOrEqual(120);
  });

  it("ignores Oracle Digital Assistant (oda-) chatbot inputs", () => {
    expect(isChatbotControl(control({ tag: "textarea", id: "oda-work-summary-text-area" }))).toBe(true);
    expect(isChatbotControl(control({ tag: "input", id: "oda-input" }))).toBe(true);
    expect(isChatbotControl(control({ tag: "input", name: "chatbot_query" }))).toBe(true);
    expect(isChatbotControl(control({ tag: "input", id: "normal-field" }))).toBe(false);

    const fields = recognizeFields([
      control({ tag: "textarea", id: "oda-work-summary-text-area" }),
      control({ tag: "input", type: "text", id: "oda-chat-input" }),
      control({ tag: "input", type: "text", name: "chatbot_message" }),
      control({ tag: "input", type: "text", id: "real-field", label: "Work Summary" })
    ]);
    expect(fields.length).toBe(1);
    expect(fields[0]!.id).toBe("real-field");
    expect(fields[0]!.label).toBe("Work Summary");
  });

  it("ignores MUI TextareaAutosize shadow textareas when resolving question labels", () => {
    // When the shadow textarea is omitted, the visible textarea is recognized with its proper label
    const fields = recognizeFields([
      control({ tag: "textarea", id: ":rb:", label: "Why do you want to join Fixture Robotics?" })
    ]);
    expect(fields[0]!.label).toBe("Why do you want to join Fixture Robotics?");
    expect(fields[0]!.kind).toBe("textarea");
    expect(fields[0]!.label).not.toMatch(UNLABELED_CONTROL_LABEL);
  });
});

describe("autofill planning", () => {
  const form = recognizeForm("https://example.com/apply", "Apply", [
    control({ tag: "input", type: "email", id: "email", label: "Email", required: true }),
    control({ tag: "input", type: "text", id: "q1", label: "Why do you want this role?", required: true }),
    control({ tag: "select", id: "q2", label: "Are you authorized to work?", options: ["Yes", "No"], required: true }),
    control({ tag: "input", type: "text", id: "q3", label: "Favorite color?", required: false }),
    control({ tag: "input", type: "text", id: "q4", label: "Solve this captcha now", required: true }),
    control({ tag: "input", type: "file", id: "resume", label: "Resume", required: true })
  ]);

  it("fills known answers and pauses on the unknown", () => {
    const plan = planAutofill(form, {
      profile: { email: "jordan@example.com" },
      resolutions: new Map([
        ["q2", { status: "RESOLVED", key: "authorized_to_work", scope: "country:US", display: "Yes", value: true }]
      ]),
      packageAnswers: [{ prompt: "Why are you interested in this role?", text: "I am excited about Aurora Labs." }],
      variantId: "11111111-1111-4111-8111-111111111111"
    });
    const byId = new Map(plan.decisions.map((decision) => [decision.fieldId, decision]));
    expect(byId.get("email")).toMatchObject({ action: "fill", value: "jordan@example.com" });
    expect(byId.get("q1")).toMatchObject({ action: "fill" });
    expect(byId.get("q1")?.basis).toMatchObject({ kind: "package-answer" });
    expect(byId.get("q2")).toMatchObject({ action: "choose", value: "Yes" });
    expect(byId.get("q3")).toMatchObject({ action: "skip" });
    expect(byId.get("q4")).toMatchObject({ action: "pause" });
    expect(byId.get("resume")).toMatchObject({ action: "upload" });
    expect(plan.safeguardHalt).toBe(true);
    expect(plan.pauses.some((pause) => pause.safeguard)).toBe(true);
  });

  it("pauses with the memory suggestion when a fact is missing", () => {
    const plan = planAutofill(form, {
      profile: {},
      resolutions: new Map([
        ["q2", { status: "NEEDS_INPUT", key: "authorized_to_work", scope: "country:US" }]
      ]),
      packageAnswers: [],
      variantId: null
    });
    const byId = new Map(plan.decisions.map((decision) => [decision.fieldId, decision]));
    expect(byId.get("email")?.action).toBe("pause");
    const pause = plan.pauses.find((entry) => entry.fieldId === "q2");
    expect(pause?.suggestedKey).toBe("authorized_to_work");
    expect(pause?.suggestedScope).toBe("country:US");
  });

  it("fills the coursework answer only into free-text fields", () => {
    const answer = "Data Structures (CS 61B); Machine Learning (CS 189, in progress)";
    const coursework = recognizeForm("https://example.com/apply", "Apply", [
      control({ tag: "textarea", id: "courses-text", label: "Relevant coursework", required: true }),
      control({ tag: "select", id: "courses-select", label: "Relevant coursework", options: ["Yes", "No"], required: true })
    ]);
    const resolution = { status: "RESOLVED", key: "relevant_coursework", scope: "global", display: answer, value: answer } as const;
    const plan = planAutofill(coursework, {
      profile: {},
      resolutions: new Map([["courses-text", resolution], ["courses-select", resolution]]),
      packageAnswers: [],
      variantId: null
    });
    const byId = new Map(plan.decisions.map((decision) => [decision.fieldId, decision]));
    expect(byId.get("courses-text")).toMatchObject({ action: "fill", value: answer });
    expect(byId.get("courses-text")?.basis).toMatchObject({ kind: "fact", key: "relevant_coursework" });
    expect(byId.get("courses-select")).toMatchObject({ action: "pause" });
  });
});

describe("upload routing", () => {
  const TRANSCRIPT_ID = "22222222-2222-4222-8222-222222222222";
  const VARIANT_ID = "11111111-1111-4111-8111-111111111111";
  const uploadForm = recognizeForm("https://example.com/apply", "Apply", [
    control({ tag: "input", type: "file", id: "resume", label: "Resume/CV", required: true }),
    control({ tag: "input", type: "file", id: "transcript", label: "Unofficial transcript", required: true }),
    control({ tag: "input", type: "file", id: "cover", label: "Cover letter", required: false }),
    control({ tag: "input", type: "file", id: "other", label: "Attachments", required: false })
  ]);

  it("classifies upload fields by what they ask for", () => {
    expect(classifyUploadRole("Resume/CV")).toBe("resume");
    expect(classifyUploadRole("Upload your résumé")).toBe("resume");
    expect(classifyUploadRole("Unofficial Transcript")).toBe("transcript");
    expect(classifyUploadRole("Academic record")).toBe("transcript");
    expect(classifyUploadRole("Cover letter")).toBe("cover");
    expect(classifyUploadRole("Attachments")).toBe("document");
    expect(classifyFieldRole(uploadForm.fields[1]!)).toBe("transcript");
    expect(hasTranscriptField(uploadForm.fields)).toBe(true);
    expect(hasTranscriptField(uploadForm.fields.filter((field) => field.id !== "transcript"))).toBe(false);
  });

  it("uploads the resume and transcript only into matching fields", () => {
    const plan = planAutofill(uploadForm, {
      profile: {},
      resolutions: new Map(),
      packageAnswers: [],
      variantId: VARIANT_ID,
      transcriptDocumentId: TRANSCRIPT_ID
    });
    const byId = new Map(plan.decisions.map((decision) => [decision.fieldId, decision]));
    expect(byId.get("resume")).toMatchObject({ action: "upload", basis: { kind: "variant", variantId: VARIANT_ID } });
    expect(byId.get("transcript")).toMatchObject({ action: "upload", basis: { kind: "candidate_document", documentId: TRANSCRIPT_ID } });
    // Neither a cover letter nor an unlabeled attachment ever receives the resume; optional ones stay empty.
    expect(byId.get("cover")).toMatchObject({ action: "skip", reason: "Optional upload left empty; the agent attaches only your resume and transcript." });
    expect(byId.get("other")?.action).toBe("skip");
    expect(plan.pauses).toEqual([]);
  });

  it("pauses a required cover letter or other document for the candidate", () => {
    const required = recognizeForm("https://example.com/apply", "Apply", [
      control({ tag: "input", type: "file", id: "cover", label: "Cover letter", required: true }),
      control({ tag: "input", type: "file", id: "sample", label: "Writing sample *" })
    ]);
    const plan = planAutofill(required, { profile: {}, resolutions: new Map(), packageAnswers: [], variantId: VARIANT_ID });
    expect(plan.decisions.map((decision) => decision.action)).toEqual(["pause", "pause"]);
    expect(plan.pauses.map((pause) => [pause.fieldId, pause.upload])).toEqual([["cover", true], ["sample", true]]);
  });

  it("pauses a transcript field when no transcript is stored", () => {
    const plan = planAutofill(uploadForm, { profile: {}, resolutions: new Map(), packageAnswers: [], variantId: VARIANT_ID });
    const transcript = plan.decisions.find((decision) => decision.fieldId === "transcript");
    expect(transcript?.action).toBe("pause");
    expect(transcript?.pause?.question).toContain("transcript");
  });

  it("recognizes Jobvite file-input-0 with Add Resume* label and sibling paste textarea as required resume upload", () => {
    const fields = recognizeFields([
      control({ tag: "input", type: "file", id: "file-input-0", label: "Add Resume*" }),
      control({ tag: "textarea", id: "jv-paste-resume-textarea0", label: "Paste resume" })
    ]);
    expect(fields[0]!.required).toBe(true);
    expect(classifyFieldRole(fields[0]!)).toBe("resume");
    expect(classifyUploadRole(fields[0]!.label, fields[0]!.id)).toBe("resume");
    const form = recognizeForm("https://jobs.jobvite.com/careers/apply", "Apply", [
      control({ tag: "input", type: "file", id: "file-input-0", label: "Add Resume*" })
    ]);
    const plan = planAutofill(form, { profile: {}, resolutions: new Map(), packageAnswers: [], variantId: VARIANT_ID });
    expect(plan.decisions[0]).toMatchObject({
      fieldId: "file-input-0",
      action: "upload",
      basis: { kind: "variant", variantId: VARIANT_ID }
    });
  });

  it("always plans resume upload for resume fields even when marked optional", () => {
    const optionalResumeForm = recognizeForm("https://example.com/apply", "Apply", [
      control({ tag: "input", type: "file", id: "optional-resume", label: "Resume (optional)", required: false }),
      control({ tag: "input", type: "file", id: "file-input-0", label: "Select", required: false })
    ]);
    const planWithResume = planAutofill(optionalResumeForm, {
      profile: {},
      resolutions: new Map(),
      packageAnswers: [],
      variantId: VARIANT_ID
    });
    expect(planWithResume.decisions[0]).toMatchObject({
      fieldId: "optional-resume",
      action: "upload",
      basis: { kind: "variant", variantId: VARIANT_ID }
    });
    expect(planWithResume.decisions[1]).toMatchObject({
      fieldId: "file-input-0",
      action: "upload",
      basis: { kind: "variant", variantId: VARIANT_ID }
    });

    const planWithoutResume = planAutofill(optionalResumeForm, {
      profile: {},
      resolutions: new Map(),
      packageAnswers: [],
      variantId: null
    });
    expect(planWithoutResume.decisions[0]).toMatchObject({
      fieldId: "optional-resume",
      action: "pause"
    });
    expect(planWithoutResume.pauses[0]?.question).toContain("asks for your resume");
  });

  it("recognizes file inputs labeled 'Add Resume*' or 'Add Resume' as resume upload even when optional or custom id", () => {
    // 1. "Add Resume" without asterisk and optional
    const formUnstarred = recognizeForm("https://jobs.jobvite.com/careers/apply", "Apply", [
      control({ tag: "input", type: "file", id: "file-input-0", label: "Add Resume", required: false })
    ]);
    expect(classifyUploadRole(formUnstarred.fields[0]!.label, formUnstarred.fields[0]!.id)).toBe("resume");
    expect(classifyFieldRole(formUnstarred.fields[0]!)).toBe("resume");
    const planUnstarred = planAutofill(formUnstarred, {
      profile: {},
      resolutions: new Map(),
      packageAnswers: [],
      variantId: VARIANT_ID
    });
    expect(planUnstarred.decisions[0]).toMatchObject({
      fieldId: "file-input-0",
      action: "upload",
      basis: { kind: "variant", variantId: VARIANT_ID }
    });

    // 2. Custom id (not file-input-0) with "Add Resume*"
    const formCustomId = recognizeForm("https://jobs.jobvite.com/careers/apply", "Apply", [
      control({ tag: "input", type: "file", id: "custom-upload-field", label: "Add Resume*" })
    ]);
    expect(classifyUploadRole(formCustomId.fields[0]!.label, formCustomId.fields[0]!.id)).toBe("resume");
    expect(classifyFieldRole(formCustomId.fields[0]!)).toBe("resume");
    const planCustomId = planAutofill(formCustomId, {
      profile: {},
      resolutions: new Map(),
      packageAnswers: [],
      variantId: VARIANT_ID
    });
    expect(planCustomId.decisions[0]).toMatchObject({
      fieldId: "custom-upload-field",
      action: "upload",
      basis: { kind: "variant", variantId: VARIANT_ID }
    });

    // 3. Custom id with "Add Resume" (no asterisk) and optional
    const formCustomOptional = recognizeForm("https://jobs.jobvite.com/careers/apply", "Apply", [
      control({ tag: "input", type: "file", id: "custom-upload-field", label: "Add Resume", required: false })
    ]);
    expect(classifyUploadRole(formCustomOptional.fields[0]!.label, formCustomOptional.fields[0]!.id)).toBe("resume");
    const planCustomOptional = planAutofill(formCustomOptional, {
      profile: {},
      resolutions: new Map(),
      packageAnswers: [],
      variantId: VARIANT_ID
    });
    expect(planCustomOptional.decisions[0]).toMatchObject({
      fieldId: "custom-upload-field",
      action: "upload",
      basis: { kind: "variant", variantId: VARIANT_ID }
    });

    // 4. Missing variantId causes pause rather than skip for "Add Resume*"
    const formWithoutVariant = recognizeForm("https://jobs.jobvite.com/careers/apply", "Apply", [
      control({ tag: "input", type: "file", id: "file-input-0", label: "Add Resume*", required: false })
    ]);
    const planWithoutVariant = planAutofill(formWithoutVariant, {
      profile: {},
      resolutions: new Map(),
      packageAnswers: [],
      variantId: null
    });
    expect(planWithoutVariant.decisions[0]).toMatchObject({
      fieldId: "file-input-0",
      action: "pause"
    });
    expect(planWithoutVariant.decisions[0]!.action).not.toBe("skip");
  });
});

describe("Handshake Quick apply dialog", () => {
  it("reads attached file names from the dialog text", () => {
    const dialog = [
      "Apply to Example Co",
      "Details from Example Co:",
      "Applying requires a resume. Attach it below and get one step closer to your next job!",
      "Attach your resume",
      "Jordan Rivera - Resume.pdf",
      "Preview document",
      "Submit Application"
    ].join("\n");
    expect(attachedNamesFromText(dialog)).toEqual(["Jordan Rivera - Resume.pdf"]);
    expect(attachedNamesFromText("Apply to Example Co\nAttach your resume\nSubmit Application")).toEqual([]);
    expect(attachedNamesFromText("Attach your resume\nJordan Rivera - Resume.pdf Preview document ×")).toEqual(["Jordan Rivera - Resume.pdf"]);
  });

  it("accepts only a confirmation that appears after the submit click", () => {
    const before = "Order confirmation emails arrive within a day. Thank you for visiting.";
    expect(readNewConfirmation(before, before)).toBe(null);
    expect(readNewConfirmation(before, `${before}\nApplication submitted`)).toContain("submitted");
    expect(readNewConfirmation("Please fix the errors below.", "Thank you! Your application was received.")).toContain("Thank you");
    expect(readNewConfirmation(before, `${before}\nApplied on January 7, 2026`)).toBe("Applied on");
    expect(readNewConfirmation("Applied on January 7, 2026", "Applied on January 7, 2026")).toBe(null);
    expect(readConfirmationFromText("Applied on January 7, 2026")).toBe("Applied on");
  });
});

describe("submission confirmation", () => {
  it("reads Dover's success message (captured from its page bundle, 2026-11-20)", () => {
    const formText = "Apply\nFirst Name *\nEmail *\nResume *\nApply\nJobs powered by";
    expect(readNewConfirmation(formText, `${formText}\nThanks for applying!`)).toBeTruthy();
  });

  function submitPage(options: { confirmAfterReads: number; dialogOpen?: boolean; url?: string }): BrowserPage {
    let reads = 0;
    let clicked = false;
    return {
      url: () => options.url ?? "https://example.com/apply",
      title: async () => "Apply",
      collectControls: async () => [],
      bodyText: async () => {
        if (clicked) reads += 1;
        return clicked && reads >= options.confirmAfterReads ? "Application submitted" : "Please review your application.";
      },
      fillField: async () => {},
      chooseOption: async () => {},
      setChecked: async () => {},
      uploadFile: async () => {},
      clickSubmit: async () => { clicked = true; },
      screenshot: async () => {},
      close: async () => {},
      applicationDialogOpen: async () => (clicked ? (options.dialogOpen ?? true) : true)
    };
  }

  it("waits for a confirmation that arrives after the click", async () => {
    await expect(submitAndConfirm(submitPage({ confirmAfterReads: 3 }), { timeoutMs: 1_000, pollMs: 1 })).resolves.toContain("Application submitted");
  });

  it("reports a closed dialog without a recognized confirmation", async () => {
    await expect(submitAndConfirm(submitPage({ confirmAfterReads: Infinity, dialogOpen: false }), { timeoutMs: 20, pollMs: 1 }))
      .rejects.toThrow(/dialog closed, but no confirmation text was recognized/);
    await expect(submitAndConfirm(submitPage({ confirmAfterReads: Infinity }), { timeoutMs: 20, pollMs: 1 }))
      .rejects.toThrow(/no new confirmation appeared/);
  });

  it("classifies a closed dialog on Dover without errors as a confirmed submission, never on Ashby", async () => {
    const dover = submitPage({ confirmAfterReads: Infinity, dialogOpen: false, url: "https://jobs.dover.com/job/123" });
    await expect(submitAndConfirm(dover, { timeoutMs: 20, pollMs: 1 })).resolves.toContain("Application submitted");

    const ashby = submitPage({ confirmAfterReads: Infinity, dialogOpen: false, url: "https://jobs.ashbyhq.com/company/123/application" });
    await expect(submitAndConfirm(ashby, { timeoutMs: 20, pollMs: 1 })).rejects.toThrow(/dialog closed, but no confirmation text was recognized/);

    const explicitDover = submitPage({ confirmAfterReads: Infinity, dialogOpen: false });
    await expect(submitAndConfirm(explicitDover, { timeoutMs: 20, pollMs: 1, atsKind: "dover" })).resolves.toContain("Application submitted");

    const explicitAshby = submitPage({ confirmAfterReads: Infinity, dialogOpen: false });
    await expect(submitAndConfirm(explicitAshby, { timeoutMs: 20, pollMs: 1, atsKind: "ashby" })).rejects.toThrow(/dialog closed, but no confirmation text was recognized/);
  });
});

describe("real-form robustness", () => {
  it("trims oversized labels, ids, and option lists instead of rejecting the form", () => {
    const longLabel = "Please describe ".repeat(30);
    const fields = recognizeFields([
      control({ tag: "textarea", id: "q".repeat(250), label: longLabel }),
      control({ tag: "select", id: "country", label: "Country", options: Array.from({ length: 600 }, (_, index) => `Country ${index} ${"x".repeat(index === 0 ? 250 : 0)}`) })
    ]);
    expect(fields[0]!.label.length).toBe(300);
    expect(fields[0]!.label.endsWith("…")).toBe(true);
    expect(fields[0]!.id.length).toBe(200);
    expect(fields[1]!.options).toHaveLength(500);
    expect(fields[1]!.options![0]!.length).toBe(200);
  });

  it("recognizes number inputs and fills them only with numbers", () => {
    const form = recognizeForm("https://example.test/apply", "Apply", [
      control({ tag: "input", type: "number", id: "year", label: "Graduation year", required: true }),
      control({ tag: "input", type: "number", id: "gpa-year", label: "Start year", required: true })
    ]);
    expect(form.fields.map((field) => field.kind)).toEqual(["number", "number"]);
    const plan = planAutofill(form, {
      profile: {},
      resolutions: new Map([
        ["year", { status: "RESOLVED", key: "graduation_year", scope: "global", display: "2028", value: "2028" }],
        ["gpa-year", { status: "RESOLVED", key: "available_start_date", scope: "global", display: "2027-06-01", value: "2027-06-01" }]
      ]),
      packageAnswers: [],
      variantId: null
    });
    expect(plan.decisions[0]).toMatchObject({ action: "fill", value: "2028" });
    expect(plan.decisions[1]).toMatchObject({ action: "pause", value: null });
    expect(plan.pauses.map((pause) => pause.fieldId)).toEqual(["gpa-year"]);
    expect(plan.pauses[0]!.question).toContain("takes a number");
  });

  it("waits for a client-rendered form to finish drawing", async () => {
    let now = 0;
    const counts = [0, 0, 0, 0, 12, 45, 45, 45, 45, 45, 45, 45];
    let reads = 0;
    const settled = await waitForStableControls(async () => counts[Math.min(reads++, counts.length - 1)]!, {
      now: () => now, sleep: async (ms) => { now += ms; }
    });
    expect(settled).toBe(45);
    expect(now).toBeGreaterThanOrEqual(2_000);

    now = 0;
    const empty = await waitForStableControls(async () => 0, { now: () => now, sleep: async (ms) => { now += ms; } });
    expect(empty).toBe(0);
    expect(now).toBeGreaterThanOrEqual(15_000);
  });
});

describe("contact details from the profile", () => {
  const profile = {
    legalFirstName: "Jordan", legalLastName: "Rivera-Park", addressLine1: "100 Fixture Way", addressCity: "Seattle",
    addressRegion: "Washington", addressPostalCode: "98101", addressCountry: "United States of America"
  };
  const plan = (controls: RawControl[], withProfile = profile) => planAutofill(recognizeForm("https://example.test/apply", "Apply", controls), {
    profile: withProfile, resolutions: new Map(), packageAnswers: [], variantId: null
  });

  it("fills standard contact labels, choosing matching options", () => {
    const result = plan([
      control({ tag: "input", type: "text", id: "first", label: "First Name*", required: true }),
      control({ tag: "input", type: "text", id: "last", label: "Legal Last Name", required: true }),
      control({ tag: "input", type: "text", id: "line1", label: "Address Line 1*", required: true }),
      control({ tag: "input", type: "text", id: "city", label: "City*", required: true }),
      control({ tag: "input", type: "text", id: "zip", label: "Postal Code*", required: true }),
      control({ tag: "select", id: "state", label: "State*", required: true, options: ["Oregon", "Washington"] }),
      control({ tag: "select", id: "country", label: "Country / Territory*", required: true, options: ["Canada", "United States of America"] })
    ]);
    expect(Object.fromEntries(result.decisions.map((decision) => [decision.fieldId, [decision.action, decision.value]]))).toEqual({
      first: ["fill", "Jordan"], last: ["fill", "Rivera-Park"], line1: ["fill", "100 Fixture Way"], city: ["fill", "Seattle"],
      zip: ["fill", "98101"], state: ["choose", "Washington"], country: ["choose", "United States of America"]
    });
    expect(result.decisions[0]!.basis).toEqual({ kind: "profile", field: "legalFirstName" });
    expect(result.pauses).toEqual([]);
  });

  it("never fills questions that merely mention a contact word, or an option the profile does not match", () => {
    const result = plan([
      control({ tag: "input", type: "text", id: "pref-city", label: "Which city would you prefer to work in?", required: true }),
      control({ tag: "input", type: "text", id: "state-reason", label: "Please state why you are interested", required: true }),
      control({ tag: "select", id: "country", label: "Country", required: true, options: ["Mexico", "Canada"] })
    ]);
    expect(result.decisions.map((decision) => decision.action)).toEqual(["pause", "pause", "pause"]);
    expect(result.pauses[2]!.question).toContain("not one of its options");
  });

  it("pauses when the profile has no value, rather than inventing one", () => {
    const result = plan([control({ tag: "input", type: "text", id: "first", label: "First Name", required: true })], {});
    expect(result.decisions[0]).toMatchObject({ action: "pause" });
  });
});

describe("Oracle Candidate Experience's one-page form labels (Track 63, labels and options from 2026-11-27 captures; fictional profile)", () => {
  const profile = { legalFirstName: "Jordan", legalLastName: "Rivera", addressRegion: "California", addressCountry: "United States of America" };
  const plan = (controls: RawControl[], withProfile: Record<string, string> = profile) => planAutofill(
    recognizeForm("https://fixture.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/10001/apply/section/1", "Apply", controls),
    { profile: withProfile, resolutions: new Map(), packageAnswers: [], variantId: null }
  );
  const actions = (result: ReturnType<typeof plan>) => Object.fromEntries(result.decisions.map((decision) => [decision.fieldId, [decision.action, decision.value]]));
  const CODES = ["+1 (United States)", "+1 (United States Minor Outlying Islands)", "+1 (American Samoa)"];

  it("matches a \"+1 (United States)\" phone-country option for any US spelling, never a territory", () => {
    expect(matchSuggestion("United States", CODES)).toBe("+1 (United States)");
    expect(matchSuggestion("United States of America", CODES)).toBe("+1 (United States)");
    expect(matchSuggestion("Canada", ["+1 (United States)"])).toBeNull();
    expect(matchCountryOption("United States of America", ["+93 (Afghanistan)", "+1 (American Samoa)", "+1 (United States)"])).toBe("+1 (United States)");
    const listed = plan([control({ tag: "select", id: "country-codes", label: "Country Code", required: true, options: ["+93 (Afghanistan)", "+1 (American Samoa)", "+1 (United States)"] })]);
    expect(actions(listed)).toEqual({ "country-codes": ["choose", "+1 (United States)"] });
    const typed = plan([control({ tag: "select", id: "country-codes", label: "Country Code", required: true, options: ["+93 (Afghanistan)", "+1 (United States)"] })], { addressCountry: "United States" });
    expect(actions(typed)).toEqual({ "country-codes": ["choose", "+1 (United States)"] });
  });

  it("reads \"First/Given Name (Please …)\" and \"Last/Family Name (Please …)\" as the legal names", () => {
    const please = "(Please enter with letters a-z, capital letters A-Z and the characters - or ‘ only. Accented and other special characters will not be recognized)";
    const result = plan([
      control({ tag: "input", type: "text", id: "firstName-41", label: `First/Given Name ${please}`, required: true }),
      control({ tag: "input", type: "text", id: "lastName-42", label: `Last/Family Name ${please}`, required: true }),
      control({ tag: "input", type: "text", id: "first-plain", label: "First Name (please use your legal name)", required: true }),
      control({ tag: "input", type: "text", id: "other-name", label: "Name (other)", required: false })
    ]);
    expect(actions(result)).toMatchObject({ "firstName-41": ["fill", "Jordan"], "lastName-42": ["fill", "Rivera"], "first-plain": ["fill", "Jordan"] });
    expect(result.decisions.find((decision) => decision.fieldId === "other-name")?.basis).not.toEqual({ kind: "profile", field: "fullName" });
  });

  it("fills \"State Abbreviation\" with the two-letter code, and nothing for a region that is no US state", () => {
    const box = [control({ tag: "input", type: "text", id: "region-52", label: "State Abbreviation", required: true })];
    expect(actions(plan(box))).toEqual({ "region-52": ["fill", "CA"] });
    expect(plan(box).decisions[0]!.basis).toEqual({ kind: "profile", field: "addressRegion" });
    expect(actions(plan(box, { addressRegion: "ca" }))).toEqual({ "region-52": ["fill", "CA"] });
    const foreign = plan(box, { addressRegion: "Ontario" });
    expect(foreign.decisions[0]!.basis).not.toEqual({ kind: "profile", field: "addressRegion" });
    expect(foreign.decisions[0]!.value).not.toBe("Ontario");
  });
});

describe("how did you hear about us", () => {
  it("recognizes the question in its usual wordings", () => {
    for (const label of ["How Did You Hear About Us?*", "How did you learn about this position?", "Where did you hear about this job?", "Source"]) {
      expect(isHearAboutQuestion(label), label).toBe(true);
    }
    expect(isHearAboutQuestion("Why do you want to work here?")).toBe(false);
  });

  it("prefers a job board, then LinkedIn, then another general board, then N/A, then any non-referral option", () => {
    expect(pickHearAboutOption(["A Philips Employee Referred me", "LinkedIn, Monster, Indeed or other Job Board", "Social Networks"], "s"))
      .toBe("LinkedIn, Monster, Indeed or other Job Board");
    expect(pickHearAboutOption(["Aboriginal Jobs Canada", "Dice", "Indeed", "LinkedIn"], "s")).toBe("LinkedIn");
    expect(pickHearAboutOption(["Employee Referral", "N/A", "Career Fair"], "s")).toBe("N/A");
    const fallback = pickHearAboutOption(["Employee Referral", "Career Fair", "Magazine", "Recruiter contacted me"], "job-1");
    expect(["Career Fair", "Magazine"]).toContain(fallback);
    expect(pickHearAboutOption(["Employee Referral", "Career Fair", "Magazine", "Recruiter contacted me"], "job-1")).toBe(fallback);
    expect(pickHearAboutOption(["Employee Referral", "A friend referred me", "Select One"], "s")).toBeNull();
  });

  it("answers a plain dropdown with the rule, and fills phone type and field of study from the profile", () => {
    const result = planAutofill(recognizeForm("https://example.test/apply", "Apply", [
      control({ tag: "select", id: "source", label: "How did you hear about us?", required: true, options: ["Employee Referral", "Job Board", "Other"] }),
      control({ tag: "select", id: "phone-type", label: "Phone Device Type*", required: true, options: ["Home", "Mobile", "Work"] }),
      control({ tag: "input", type: "text", id: "major", label: "Field of Study", required: true })
    ]), { profile: { phoneType: "Mobile", fieldOfStudy: "Computer Science" }, resolutions: new Map(), packageAnswers: [], variantId: null });
    expect(result.decisions.map((decision) => [decision.fieldId, decision.action, decision.value])).toEqual([
      ["source", "choose", "Job Board"], ["phone-type", "choose", "Mobile"], ["major", "fill", "Computer Science"]
    ]);
  });

  it("reads \"How did you connect with us?\" as the same question and picks Other when no listed source is a job board (Track 67)", () => {
    expect(isHearAboutQuestion("How did you connect with us?")).toBe(true);
    expect(isHearAboutQuestion("Would you like to connect with us on LinkedIn?")).toBe(false);
    const CONNECT = ["Fixture Fest", "Through a partnership (Fixture Club)", "On-campus event", "Virtual event", "Other"];
    // Before the Other tier, the seed "connect-1" picked "On-campus event", an event the candidate never attended.
    expect(pickHearAboutOption(CONNECT, "connect-1", "Online job board")).toBe("Other");
    expect(pickHearAboutOption(["Job Board", "Other"], "connect-1")).toBe("Job Board");
    expect(pickHearAboutOption(["N/A", "Other"], "connect-1")).toBe("N/A");
    const result = planAutofill(recognizeForm("https://example.test/apply", "Apply", [
      control({ tag: "select", id: "connect", label: "How did you connect with us?", required: true, options: CONNECT })
    ]), {
      profile: {},
      resolutions: new Map([["connect", { status: "RESOLVED", key: "how_heard", scope: "global", display: "Online job board", value: "Online job board" }]]),
      packageAnswers: [],
      variantId: null
    });
    expect(result.decisions[0]).toMatchObject({ fieldId: "connect", action: "choose", value: "Other", basis: { kind: "fact", key: "how_heard", scope: "global" } });
  });

  it("fills a phone number box with the profile phone's digits only, and nothing from a number too short to be a phone (Track 67)", () => {
    const phonePlan = (kind: "number" | "text", phone: string) => planAutofill(recognizeForm("https://example.test/apply", "Apply", [
      control({ tag: "input", type: kind, id: "phone-number", label: "Phone", required: true })
    ]), { profile: { phone }, resolutions: new Map(), packageAnswers: [], variantId: null }).decisions[0]!;
    expect(phonePlan("number", "(555) 010-0199")).toMatchObject({ action: "fill", value: "5550100199", basis: { kind: "profile", field: "phone" } });
    const short = phonePlan("number", "12345");
    expect(short.action).toBe("pause");
    expect(short.basis).toBeNull();
    expect(phonePlan("text", "(555) 010-0199")).toMatchObject({ action: "fill", value: "(555) 010-0199", basis: { kind: "profile", field: "phone" } });
  });
});

describe("CAPTCHA token fields and checkbox groups (Greenhouse's new board)", () => {
  it("recognizes Turnstile's challenge frame by its address only", () => {
    expect(isTurnstileFrameSource("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/fixture/normal")).toBe(true);
    expect(isTurnstileFrameSource("https://CHALLENGES.cloudflare.com/x")).toBe(true);
    for (const other of ["https://challenges.cloudflare.com.example.test/x", "https://example.com/?u=challenges.cloudflare.com", "about:blank", "chrome-error://chromewebdata/", ""]) {
      expect(isTurnstileFrameSource(other)).toBe(false);
    }
  });

  it("drops the hidden CAPTCHA token fields instead of reading them as a CAPTCHA question", () => {
    const fields = recognizeFields([
      control({ tag: "textarea", id: "g-recaptcha-response-100000", name: "g-recaptcha-response" }),
      control({ tag: "textarea", name: "h-captcha-response" }),
      control({ tag: "input", type: "text", id: "first_name", label: "First Name", required: true })
    ]);
    expect(fields.map((field) => field.label)).toEqual(["First Name"]);
  });

  it("treats only CAPTCHA wording as a safeguard, not the word challenge", () => {
    const form = recognizeForm("https://example.test/apply", "Apply", [
      control({ tag: "textarea", id: "q1", label: "Describe a technical challenge you solved", required: false }),
      control({ tag: "input", type: "text", id: "q2", label: "Solve this captcha now", required: true })
    ]);
    expect(form.fields.map(isSafeguardField)).toEqual([false, true]);
    const plan = planAutofill(form, { profile: {}, resolutions: new Map(), packageAnswers: [], variantId: null });
    expect(plan.pauses.filter((pause) => pause.safeguard).map((pause) => pause.fieldId)).toEqual(["q2"]);
  });

  const group = (id: string, label: string, options: string[], required = true) =>
    control({ tag: "input", type: "checkbox", widget: "checkbox-group", id, label, required, options });
  const hearAbout = group("question_1[]", "How did you hear about this role?", ["LinkedIn", "Glassdoor", "Indeed", "Referred by a friend"]);
  const planWith = (controls: RawControl[], resolutions: Map<string, FieldResolution>) =>
    planAutofill(recognizeForm("https://example.test/apply", "Apply", controls), { profile: {}, resolutions, packageAnswers: [], variantId: null });

  it("answers a How-did-you-hear checkbox group as one question from the saved how_heard fact", () => {
    const saved = (display: string): Map<string, FieldResolution> =>
      new Map([["question_1[]", { status: "RESOLVED", key: "how_heard", scope: "global", display, value: display }]]);
    const online = planWith([hearAbout], saved("Online job board"));
    expect(online.decisions).toEqual([expect.objectContaining({
      fieldId: "question_1[]", action: "choose", value: "LinkedIn", basis: { kind: "fact", key: "how_heard", scope: "global" }
    })]);
    expect(online.pauses).toEqual([]);
    expect(planWith([hearAbout], saved("Indeed")).decisions[0]).toMatchObject({ action: "choose", value: "Indeed" });
    const referralOnly = planWith([group("question_2[]", "How did you hear about this role?", ["Referred by a friend", "Employee"])], new Map());
    expect(referralOnly.decisions[0]?.value).not.toBe("Referred by a friend");
    expect(referralOnly.decisions[0]?.action).toBe("pause");
  });

  it("chooses one option of another checkbox group, pauses or skips without an answer, and never checks the group", () => {
    const tools = group("question_3[]", "Which tools have you used?", ["Python", "Rust", "Go"]);
    const resolved = planWith([tools], new Map([["question_3[]", { status: "RESOLVED", key: "primary_tool", scope: "global", display: "rust", value: "rust" }]]));
    expect(resolved.decisions[0]).toMatchObject({ action: "choose", value: "Rust" });
    expect(planWith([tools], new Map()).decisions[0]).toMatchObject({ action: "pause" });
    expect(planWith([group("question_4[]", "Which tools have you used?", ["Python", "Rust"], false)], new Map()).decisions[0]).toMatchObject({ action: "skip" });
    const affirmed = planWith([tools], new Map([["question_3[]", { status: "RESOLVED", key: "primary_tool", scope: "global", display: "Yes", value: true }]]));
    expect(affirmed.decisions.map((decision) => decision.action)).not.toContain("check");
  });

  it("matches a phone-country list option that carries the dialing code", () => {
    const result = planAutofill(recognizeForm("https://example.test/apply", "Apply", [
      control({ tag: "select", id: "country", label: "Country*", required: true, options: ["Canada +1", "United States +1", "United Kingdom +44"] })
    ]), { profile: { addressCountry: "United States" }, resolutions: new Map(), packageAnswers: [], variantId: null });
    expect(result.decisions[0]).toMatchObject({ action: "choose", value: "United States +1", basis: { kind: "profile", field: "addressCountry" } });
  });
});

describe("real ATS labels, contact fields, choices, and type-aheads (Lever, Ashby, Greenhouse)", () => {
  const resolved = (key: string, value: boolean | string): FieldResolution =>
    ({ status: "RESOLVED", key, scope: "global", display: typeof value === "string" ? value : value ? "Yes" : "No", value });
  const profile = {
    fullName: "Jordan Rivera", email: "jordan@example.test", phone: "+1 555 0100", linkedinUrl: "https://www.linkedin.com/in/jordan-fixture",
    githubUrl: "https://github.com/jordan-fixture", addressCity: "Berkeley", addressRegion: "California"
  };
  const plan = (controls: RawControl[], resolutions = new Map<string, FieldResolution>()) => planAutofill(
    recognizeForm("https://jobs.lever.co/fixture/1/apply", "Apply", controls),
    { profile, resolutions, packageAnswers: [], variantId: null }
  );

  it("strips required markers from labels and reads them as required", () => {
    expect(stripRequiredMarker("Full name✱")).toEqual({ label: "Full name", marked: true });
    expect(stripRequiredMarker("Phone ✱")).toEqual({ label: "Phone", marked: true });
    expect(stripRequiredMarker("Email *")).toEqual({ label: "Email", marked: true });
    expect(stripRequiredMarker("Name (required)")).toEqual({ label: "Name", marked: true });
    expect(stripRequiredMarker("Location ＊")).toEqual({ label: "Location", marked: true });
    expect(stripRequiredMarker("Why us?")).toEqual({ label: "Why us?", marked: false });
    const fields = recognizeFields([
      control({ tag: "input", type: "text", id: "name", label: "Full name✱" }),
      control({ tag: "input", type: "text", id: "phone", label: "Phone ✱" })
    ]);
    expect(fields.map((field) => [field.label, field.required])).toEqual([["Full name", true], ["Phone", true]]);
  });

  it("fills Name, Email (a text box), Phone, LinkedIn, GitHub, and Current location from the profile", () => {
    const result = plan([
      control({ tag: "input", type: "text", id: "name", label: "Full name✱" }),
      control({ tag: "input", type: "text", id: "ashby-name", label: "Name", required: true }),
      control({ tag: "input", type: "text", id: "email", label: "Email", required: true }),
      control({ tag: "input", type: "text", id: "phone", label: "Phone ✱" }),
      control({ tag: "input", type: "url", id: "linkedin", label: "LinkedIn", required: true }),
      control({ tag: "input", type: "text", id: "linkedin-url", label: "LinkedIn URL" }),
      control({ tag: "input", type: "text", id: "github", label: "GitHub URL" }),
      control({ tag: "input", type: "text", id: "location", label: "Current location ✱" })
    ]);
    expect(Object.fromEntries(result.decisions.map((decision) => [decision.fieldId, [decision.action, decision.value]]))).toEqual({
      name: ["fill", "Jordan Rivera"], "ashby-name": ["fill", "Jordan Rivera"], email: ["fill", "jordan@example.test"],
      phone: ["fill", "+1 555 0100"], linkedin: ["fill", "https://www.linkedin.com/in/jordan-fixture"],
      "linkedin-url": ["fill", "https://www.linkedin.com/in/jordan-fixture"], github: ["fill", "https://github.com/jordan-fixture"],
      location: ["fill", "Berkeley, California"]
    });
    expect(result.decisions[2]!.basis).toEqual({ kind: "profile", field: "email" });
    expect(result.pauses).toEqual([]);
  });

  it("never types a known answer into a radio set: it chooses an offered option or pauses", () => {
    const radio = control({ tag: "input", type: "radio", id: "cards[1][field0]", label: "Nationality status", required: true, options: ["EU national", "Non Applicable I am a national of a Member State of the European Union"] });
    const unmatched = plan([radio], new Map([["cards[1][field0]", resolved("authorized_to_work", "Yes")]]));
    expect(unmatched.decisions[0]!.action).toBe("pause");
    const noOptions = plan([control({ tag: "input", type: "radio", id: "r", label: "Do you agree?", required: true })], new Map([["r", resolved("custom", "Yes")]]));
    expect(noOptions.decisions[0]).toMatchObject({ action: "pause" });
    expect(noOptions.decisions[0]!.pause?.question).toContain("is a choice");
    const matched = plan([{ ...radio, options: ["Yes", "No"] }], new Map([["cards[1][field0]", resolved("authorized_to_work", "Yes")]]));
    expect(matched.decisions[0]).toMatchObject({ action: "choose", value: "Yes" });
  });

  it("types a known value into a type-ahead and picks the suggestion instead of filling", () => {
    const result = plan([
      control({ tag: "input", type: "text", id: "location-input", label: "Current location ✱", widget: "autocomplete" }),
      control({ tag: "select", id: "candidate-location", label: "Location (City)", widget: "autocomplete", options: [] }),
      control({ tag: "input", type: "text", id: "school", label: "School", widget: "autocomplete", required: true }),
      control({ tag: "input", type: "text", id: "optional-city", label: "Preferred office", widget: "autocomplete" })
    ], new Map([["school", resolved("school", "University of California, Berkeley")]]));
    expect(result.decisions.map((decision) => [decision.fieldId, decision.action, decision.value])).toEqual([
      ["location-input", "choose", "Berkeley, California"],
      ["candidate-location", "choose", "Berkeley, California"],
      ["school", "choose", "University of California, Berkeley"],
      ["optional-city", "skip", null]
    ]);
    expect(result.decisions[0]!.reason).toBe("Typed into the site's suggestion list and picked the matching suggestion.");
    const required = plan([control({ tag: "input", type: "text", id: "city", label: "Preferred office", widget: "autocomplete", required: true })]);
    expect(required.decisions[0]!.action).toBe("pause");
  });

  it("answers current-location questions from the profile, a city of residence from the profile city, and leaves office and work-location choices paused (Track 71)", () => {
    const result = plan([
      control({ tag: "input", type: "text", id: "location", label: "Location", required: true }),
      control({ tag: "input", type: "text", id: "located", label: "Where are you located?", required: true }),
      control({ tag: "input", type: "text", id: "reside-city", label: "What city do you currently reside in?", required: true }),
      control({ tag: "input", type: "text", id: "live-city", label: "Which city do you live in?", required: true }),
      control({ tag: "select", id: "office-first", label: "Which of the following office locations would be your first preference?", required: true, options: ["Berkeley, California", "Exampleville, Texas"] }),
      control({ tag: "select", id: "applying-for", label: "Which location are you applying for?", required: true, options: ["Berkeley, California", "Exampleville, Texas"] }),
      control({ tag: "select", id: "program-location", label: "Where would you be located during the internship program?", required: true, options: ["United States", "Canada"] }),
      control({ tag: "input", type: "text", id: "work-city", label: "What city would you like to work in?", required: true }),
      control({ tag: "input", type: "text", id: "preferred-office", label: "Preferred office", required: true })
    ]);
    expect(Object.fromEntries(result.decisions.map((decision) => [decision.fieldId, [decision.action, decision.value]]))).toEqual({
      location: ["fill", "Berkeley, California"], located: ["fill", "Berkeley, California"],
      "reside-city": ["fill", "Berkeley"], "live-city": ["fill", "Berkeley"],
      "office-first": ["pause", null], "applying-for": ["pause", null], "program-location": ["pause", null],
      "work-city": ["pause", null], "preferred-office": ["pause", null]
    });
    expect(result.decisions.find((decision) => decision.fieldId === "location")!.basis).toEqual({ kind: "profile", field: "currentLocation" });
    expect(result.decisions.find((decision) => decision.fieldId === "reside-city")!.basis).toEqual({ kind: "profile", field: "addressCity" });
    // With no city and state on the profile, a saved question-memory answer is typed into a Location type-ahead instead.
    const remembered = planAutofill(recognizeForm("https://jobs.ashbyhq.com/fixture/1/application", "Apply", [
      control({ tag: "input", type: "text", ref: "ia-control-1", label: "Location", required: true, widget: "autocomplete" })
    ]), {
      profile: {},
      resolutions: new Map([["ia-control-1", { status: "REMEMBERED_ANSWER", answerId: "answer-1", answer: "Fixture City, CA", answerKey: "fixture city ca", answerKind: "text" } as const]]),
      packageAnswers: [], variantId: null
    });
    expect(remembered.decisions[0]).toMatchObject({ action: "choose", value: "Fixture City, CA", basis: { kind: "question_answer", answerId: "answer-1" } });
  });

  it("matches a suggestion exactly or uniquely, never by guessing", () => {
    expect(matchSuggestion("Seattle", ["Seattle", "Seattle, Washington, United States"])).toBe("Seattle");
    expect(matchSuggestion("South San Francisco", ["South San Francisco, California, United States", "San Francisco, California, United States"]))
      .toBe("South San Francisco, California, United States");
    expect(matchSuggestion("Berkeley", ["Berkeley, California, United States", "Berkeley, Missouri, United States"])).toBeNull();
    expect(matchSuggestion("Berkeley, California", ["Berkeley, California, United States", "Berkeley, Missouri, United States"]))
      .toBe("Berkeley, California, United States");
    expect(matchSuggestion("Springfield, IL", ["Springfield, Illinois, United States", "Springfield, Missouri, United States"]))
      .toBe("Springfield, Illinois, United States");
    expect(matchSuggestion("Zurich", ["Zürich, Switzerland", "Zug, Switzerland"])).toBe("Zürich, Switzerland");
    expect(matchSuggestion("Austin", [])).toBeNull();
  });

  it("pauses a data-retention consent checkbox with a plain reason, even when memory says yes", () => {
    const label = "I agree that Fixture Robotics has my consent to retain my data for up to 3 years for future roles.";
    const result = plan([
      control({ tag: "input", type: "checkbox", id: "consent", label }),
      control({ tag: "input", type: "checkbox", id: "consent-required", label: "I consent to the processing of my personal data", required: true })
    ], new Map([["consent", resolved("custom", true)], ["consent-required", resolved("custom", true)]]));
    expect(result.decisions.map((decision) => decision.action)).toEqual(["pause", "pause"]);
    expect(result.pauses.map((pause) => pause.question)).toEqual([CONSENT_QUESTION, CONSENT_QUESTION]);
    expect(CONSENT_QUESTION).toBe("consent checkbox: needs your OK");
    expect(result.decisions.some((decision) => decision.action === "check")).toBe(false);
  });

  it("chooses a saved question answer for a type-ahead and a checkbox group, never ticking a consent box", () => {
    const answerId = "6f1d0c1e-8f3a-4c2b-9d7e-1a2b3c4d5e6f";
    const saved = (answer: string, answerKind: "text" | "option"): FieldResolution =>
      ({ status: "REMEMBERED_ANSWER", answerId, answer, answerKey: answer.toLowerCase(), answerKind });
    const basis = { kind: "question_answer", answerId };
    const typeAhead = control({ tag: "input", type: "text", id: "office", label: "Preferred office", widget: "autocomplete", required: true });
    const optionalTypeAhead = control({ tag: "input", type: "text", id: "office-optional", label: "Preferred office", widget: "autocomplete" });
    const reactSelect = control({ tag: "select", id: "school", label: "Which school do you attend?", widget: "autocomplete", options: [], required: true });
    const result = plan([typeAhead, optionalTypeAhead, reactSelect], new Map([
      ["office", saved("Seattle", "text")], ["office-optional", saved("Seattle", "text")], ["school", saved("University of Washington", "option")]
    ]));
    expect(result.decisions.map((decision) => [decision.fieldId, decision.action, decision.value])).toEqual([
      ["office", "choose", "Seattle"], ["office-optional", "choose", "Seattle"], ["school", "choose", "University of Washington"]
    ]);
    expect(result.decisions.every((decision) => JSON.stringify(decision.basis) === JSON.stringify(basis))).toBe(true);
    expect(result.decisions[0]!.reason).toBe("Your saved answer, typed into the site's suggestion list.");
    expect(result.pauses).toEqual([]);

    const group = control({ tag: "input", type: "checkbox", id: "tools", label: "Which tools do you use?", required: true, options: ["Git", "Docker"] });
    const chosen = plan([group], new Map([["tools", saved("git", "option")]]));
    expect(chosen.decisions[0]).toMatchObject({ action: "choose", value: "Git", basis });
    const unmatched = plan([group], new Map([["tools", saved("Kubernetes", "option")]]));
    expect(unmatched.decisions[0]!.action).toBe("pause");
    expect(unmatched.decisions[0]!.pause?.question).toBe('Your saved answer to "Which tools do you use?" is not one of its options. How should it be answered?');
    expect(JSON.stringify(unmatched)).not.toContain("Kubernetes");

    const consent = plan([control({ tag: "input", type: "checkbox", id: "consent", label: "I consent to the processing of my personal data", required: true })],
      new Map([["consent", saved("Yes", "option")]]));
    expect(consent.decisions[0]!.action).toBe("pause");
    expect(consent.pauses.map((pause) => pause.question)).toEqual([CONSENT_QUESTION]);
  });

  it("records the field kind and options on the pause for a field the page would not take", () => {
    const [select] = recognizeFields([control({ tag: "select", id: "auth", label: "Work authorization", required: true, options: ["Yes", "No"] })]);
    const held = unfilledPause(select!, "the field did not respond in time");
    expect(held.pause).toMatchObject({ fieldId: "auth", fieldKind: "select", options: ["Yes", "No"], status: "open" });
    const [text] = recognizeFields([control({ tag: "input", type: "text", id: "editor", label: "Favorite editor" })]);
    const plain = unfilledPause(text!, "the page did not accept the value");
    expect(plain.pause.fieldKind).toBe("text");
    expect(plain.pause.options).toBeUndefined();
  });
});

describe("real-form question coverage (education block, country, city, preferred name, buttons, Ashby confirmation)", () => {
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const graduation = (date: string) => ({ date, basis: { kind: "fact" as const, key: "graduation_date", scope: "global" } });
  const educationForm = (overrides: { endRequired?: boolean; degreeOptions?: string[] } = {}): RawControl[] => [
    control({ tag: "select", id: "school--0", label: "School*", required: true, widget: "autocomplete", options: ["Aalto University"] }),
    control({ tag: "select", id: "degree--0", label: "Degree*", required: true, options: overrides.degreeOptions ?? ["Associate's Degree", "Bachelor’s Degree", "Master's Degree"] }),
    control({ tag: "select", id: "start-month--0", label: "Start date month", options: MONTHS }),
    control({ tag: "input", type: "number", id: "start-year--0", label: "Start date year" }),
    control({ tag: "select", id: "end-month--0", label: "End date month", required: overrides.endRequired ?? true, options: MONTHS }),
    control({ tag: "input", type: "number", id: "end-year--0", label: "End date year", required: overrides.endRequired ?? true }),
    control({ tag: "select", id: "country", label: "Country*", required: true, options: ["Canada +1", "United States +1"] })
  ];
  type Inputs = Parameters<typeof planAutofill>[1];
  const plan = (controls: RawControl[], education: Inputs["education"], profile: Inputs["profile"] = { addressCountry: "USA" }) =>
    planAutofill(recognizeForm("https://job-boards.greenhouse.io/fixture/jobs/1", "Apply", controls), {
      profile, resolutions: new Map(), packageAnswers: [], variantId: null, education
    });
  const actions = (result: ReturnType<typeof planAutofill>) =>
    Object.fromEntries(result.decisions.map((decision) => [decision.fieldId, [decision.action, decision.value]]));
  const education = { school: "Example State University", degree: "B.A. Computer Science", startMonth: "2024-08", graduation: graduation("2028-05-15") };

  it("fills the education block and the phone country from the profile and the run's graduation date", () => {
    const result = plan(educationForm(), education);
    expect(actions(result)).toEqual({
      "school--0": ["choose", "Example State University"], "degree--0": ["choose", "Bachelor’s Degree"],
      "start-month--0": ["choose", "August"], "start-year--0": ["fill", "2024"], "end-month--0": ["choose", "May"],
      "end-year--0": ["fill", "2028"], country: ["choose", "United States +1"]
    });
    expect(result.pauses).toEqual([]);
    const byId = (id: string) => result.decisions.find((decision) => decision.fieldId === id)!;
    expect(byId("end-year--0").basis).toEqual({ kind: "fact", key: "graduation_date", scope: "global" });
    expect(byId("start-month--0").basis).toEqual({ kind: "profile", field: "educationStartMonth" });
    expect(byId("degree--0").basis).toEqual({ kind: "profile", field: "degree" });

    const transcript = plan(educationForm(), { ...education, graduation: { date: "2029-05-15", basis: { kind: "fact", key: "graduation_date", scope: "channel:handshake_internal" } } });
    expect(actions(transcript)["end-year--0"]).toEqual(["fill", "2029"]);
    expect(actions(transcript)["end-month--0"]).toEqual(["choose", "May"]);
  });

  it("pauses or skips the end date with no graduation date for the run's profile, and never derives one", () => {
    const required = plan(educationForm(), { ...education, graduation: undefined });
    expect(actions(required)["end-month--0"]![0]).toBe("pause");
    expect(actions(required)["end-year--0"]![0]).toBe("pause");
    const optional = plan(educationForm({ endRequired: false }), { ...education, graduation: undefined });
    expect(actions(optional)["end-month--0"]).toEqual(["skip", null]);
    expect(actions(optional)["end-year--0"]).toEqual(["skip", null]);
  });

  it("never fills Greenhouse's employment block dates from education data, though they share the education labels", () => {
    const employment = (required: boolean): RawControl[] => [
      control({ tag: "select", id: "start-date-month--0", label: "Start date month", required, options: MONTHS }),
      control({ tag: "input", type: "number", id: "start-date-year--0", label: "Start date year", required }),
      control({ tag: "select", id: "end-date-month--0", label: "End date month", required, options: MONTHS }),
      control({ tag: "input", type: "number", id: "end-date-year--0", label: "End date year", required })
    ];
    const optional = actions(plan([...educationForm(), ...employment(false)], education));
    expect(optional).toMatchObject({
      "start-month--0": ["choose", "August"], "start-year--0": ["fill", "2024"], "end-month--0": ["choose", "May"], "end-year--0": ["fill", "2028"],
      "start-date-month--0": ["skip", null], "start-date-year--0": ["skip", null], "end-date-month--0": ["skip", null], "end-date-year--0": ["skip", null]
    });
    const required = actions(plan([...educationForm(), ...employment(true)], education));
    for (const id of ["start-date-month--0", "start-date-year--0", "end-date-month--0", "end-date-year--0"]) {
      expect(required[id]![0]).toBe("pause");
    }
    expect(required["end-year--0"]).toEqual(["fill", "2028"]);
  });

  it("pauses the degree when it is missing or no option fits, and never picks a B.S. for a B.A.", () => {
    expect(actions(plan(educationForm(), { ...education, degree: undefined }))["degree--0"]![0]).toBe("pause");
    const mismatch = plan(educationForm({ degreeOptions: ["Bachelor of Science", "Master's Degree"] }), education);
    expect(actions(mismatch)["degree--0"]![0]).toBe("pause");
    expect(mismatch.pauses.find((pause) => pause.fieldId === "degree--0")!.question)
      .toBe('Your profile degree "B.A. Computer Science" matches none of the options for "Degree". Which option should be chosen?');
  });

  it("chooses the school by name from a native list, types its full name into a searched one, and pauses when it is missing", () => {
    const native = [control({ tag: "select", id: "school", label: "School", required: true, options: ["University of California, Berkeley Extension", "University of California, Berkeley"] })];
    expect(actions(plan(native, { school: "UC Berkeley" }))).toEqual({ school: ["choose", "University of California, Berkeley"] });
    const absent = [control({ tag: "select", id: "school", label: "School", required: true, options: ["Stanford University", "Other"] })];
    expect(actions(plan(absent, { school: "UC Berkeley" }))["school"]![0]).toBe("pause");
    expect(actions(plan(absent, {}))["school"]![0]).toBe("pause");
    const searched = [control({ tag: "select", id: "school--0", label: "School", required: true, widget: "autocomplete", options: [] })];
    expect(actions(plan(searched, { school: "UC Berkeley" }))).toEqual({ "school--0": ["choose", "University of California, Berkeley"] });
  });

  it("matches country options across US spellings and dialing codes", () => {
    expect(matchCountryOption("USA", ["Canada +1", "United States +1"])).toBe("United States +1");
    expect(matchCountryOption("United States", ["United States of America", "Canada"])).toBe("United States of America");
    expect(matchCountryOption("US", ["US", "Canada"])).toBe("US");
    expect(matchCountryOption("United States", ["United States", "USA"])).toBeNull();
    expect(matchCountryOption("Canada", ["Canada +1"])).toBe("Canada +1");
    expect(matchCountryOption("Mexico", ["Canada", "United States"])).toBeNull();
  });

  it("matches a City, ST value against spelled-out states and the reverse, never guessing", () => {
    expect(matchSuggestion("Springfield, IL", ["Springfield, Illinois, United States", "Springfield, Missouri, United States"])).toBe("Springfield, Illinois, United States");
    expect(matchSuggestion("Springfield, Illinois", ["Springfield, IL, USA", "Springfield, MO, USA"])).toBe("Springfield, IL, USA");
    expect(matchSuggestion("Springfield, IL", ["Springfield, Illinois, United States", "Springfield, Illinois (Sangamon County), United States"])).toBeNull();
  });

  it("matches a catalog's dash spelling by the same words, never between two", () => {
    expect(matchSuggestion("University of Example, Springfield", ["University of Example - Springfield", "University of Example - Shelbyville"]))
      .toBe("University of Example - Springfield");
    expect(matchSuggestion("University of Example, Springfield", ["University of Example - Springfield", "University of Example: Springfield"])).toBeNull();
  });

  it("matches type-ahead suggestions using hyphenated campus names and prompt search terms", () => {
    const berkeley = "University of California, Berkeley";
    const catalog = ["University of California - Berkeley", "University of California - Davis", "University of California - Los Angeles"];
    expect(matchSuggestion(berkeley, catalog)).toBe("University of California - Berkeley");
    const hyphenated = berkeley.replace(/,\s*/g, " - ");
    expect(hyphenated).toBe("University of California - Berkeley");
    expect(matchSuggestion(hyphenated, catalog)).toBe("University of California - Berkeley");
    expect(promptSearchTerms(berkeley)).toContain("berkeley");
    expect(matchSuggestion("UC Berkeley", catalog)).toBe("University of California - Berkeley");
  });

  it("names a control with no id or name by its adapter tag", () => {
    expect(recognizeFields([control({ tag: "input", type: "text", ref: "ia-control-3", label: "Location" })])[0]!.id).toBe("ia-control-3");
  });

  it("answers a state-of-residence list from the profile region, by name or code, and never a distance question", () => {
    const stateList = [control({ tag: "select", id: "question_1", label: "What state do you currently reside in?*", required: true, options: ["Alabama", "Illinois", "Missouri"] })];
    const code = plan(stateList, undefined, { addressRegion: "IL" });
    expect(actions(code)).toEqual({ question_1: ["choose", "Illinois"] });
    expect(code.decisions[0]!.basis).toEqual({ kind: "profile", field: "addressRegion" });
    expect(actions(plan(stateList, undefined, { addressRegion: "Illinois" }))).toEqual({ question_1: ["choose", "Illinois"] });
    const foreign = plan(stateList, undefined, { addressRegion: "ON" });
    expect(actions(foreign)).toEqual({ question_1: ["pause", null] });
    expect(foreign.pauses[0]!.question).toContain('Your profile says "ON"');
    const distance = [control({ tag: "select", id: "question_2", label: "Do you currently reside within 50 miles from Fixture City, California?*", required: true, options: ["Yes", "No"] })];
    expect(actions(plan(distance, undefined, { addressRegion: "CA", addressCity: "Fixture City" }))).toEqual({ question_2: ["pause", null] });
  });

  it("answers a current-university list with the school or its campus, never Other", () => {
    const universities = [control({ tag: "select", id: "question_3", label: "Which university are you currently attending?*", required: true, options: ["Springfield", "Stanford", "UC Davis", "Other"] })];
    expect(actions(plan(universities, { school: "University of Example, Springfield" }))).toEqual({ question_3: ["choose", "Springfield"] });
    expect(actions(plan(universities, { school: "UC Davis" }))).toEqual({ question_3: ["choose", "UC Davis"] });
    expect(actions(plan(universities, { school: "Example State University" }))).toEqual({ question_3: ["pause", null] });
  });

  it("pauses a required preferred first name with no saved value, under its own label", () => {
    const required = [control({ tag: "input", type: "text", id: "preferred_name", label: "Preferred First Name*", required: true })];
    const paused = plan(required, undefined, { legalFirstName: "Jordan" });
    expect(actions(paused)).toEqual({ preferred_name: ["pause", null] });
    expect(paused.pauses.map((pause) => pause.label)).toEqual(["Preferred First Name"]);
  });

  it("fills a preferred name only from the profile's own preferred name", () => {
    const optional = [control({ tag: "input", type: "text", id: "preferred_name", label: "Preferred First Name" })];
    const required = [control({ tag: "input", type: "text", id: "preferred_name", label: "Preferred name*", required: true })];
    expect(actions(plan(optional, undefined, { preferredName: "Jo", legalFirstName: "Jordan" }))).toEqual({ preferred_name: ["fill", "Jo"] });
    expect(actions(plan(optional, undefined, { legalFirstName: "Jordan" }))).toEqual({ preferred_name: ["skip", null] });
    const paused = plan(required, undefined, { legalFirstName: "Jordan", fullName: "Jordan Rivera" });
    expect(actions(paused)).toEqual({ preferred_name: ["pause", null] });
    expect(JSON.stringify(paused.decisions)).not.toContain("Jordan");
  });

  it("never reads a button as a field", () => {
    const fields = recognizeFields([
      control({ tag: "input", type: "button", id: "discard", label: "Discard" }),
      control({ tag: "input", type: "reset", id: "back", label: "Back" }),
      control({ tag: "input", type: "datetime-local", id: "submit-like", label: "Submit" }),
      control({ tag: "input", type: "datetime-local", id: "availability", label: "Interview availability" }),
      control({ tag: "input", type: "email", id: "email", label: "Email Address" })
    ]);
    expect(fields.map((field) => field.label)).toEqual(["Interview availability", "Email Address"]);
  });

  it("reads more confirmation phrasings", () => {
    expect(readNewConfirmation("form text", "Thanks for applying!")).toBeTruthy();
    expect(readNewConfirmation("form text", "Your application has been submitted.")).toBeTruthy();
  });

  describe("a site's own success container", () => {
    const stubPage = (successBefore: string, successAfter: string | null): BrowserPage => {
      let clicked = false;
      const page: BrowserPage = {
        url: () => "https://jobs.ashbyhq.com/fixture/1/application",
        title: async () => "Apply",
        collectControls: async () => [],
        bodyText: async () => "Robotics Software Intern Submit Application",
        fillField: async () => {},
        chooseOption: async () => {},
        setChecked: async () => {},
        uploadFile: async () => {},
        clickSubmit: async () => { clicked = true; },
        screenshot: async () => {},
        close: async () => {}
      };
      if (successAfter !== null) page.successText = async () => (clicked ? successAfter : successBefore);
      return page;
    };

    it("counts a success container that appears after the click", async () => {
      await expect(submitAndConfirm(stubPage("", "Success We got it!"), { timeoutMs: 200, pollMs: 1 })).resolves.toBe("Success We got it!");
    });

    it("fails closed when the container was already there, or when nothing is recognized", async () => {
      await expect(submitAndConfirm(stubPage("Success We got it!", "Success We got it!"), { timeoutMs: 20, pollMs: 1 }))
        .rejects.toThrow(/no new confirmation appeared/);
      await expect(submitAndConfirm(stubPage("", ""), { timeoutMs: 20, pollMs: 1 })).rejects.toThrow(/not marked submitted/);
      await expect(submitAndConfirm(stubPage("", null), { timeoutMs: 20, pollMs: 1 })).rejects.toThrow(/no new confirmation appeared/);
    });
  });
});

describe("known answers on common application questions (synthetic Greenhouse-style labels)", () => {
  type Inputs = Parameters<typeof planAutofill>[1];
  const plan = (controls: RawControl[], extra: Partial<Inputs> = {}) =>
    planAutofill(recognizeForm("https://job-boards.greenhouse.io/fixture/jobs/2", "Apply", controls), {
      profile: {}, resolutions: new Map(), packageAnswers: [], variantId: null, ...extra
    });
  const actions = (result: ReturnType<typeof planAutofill>) =>
    Object.fromEntries(result.decisions.map((decision) => [decision.fieldId, [decision.action, decision.value]]));
  const graduation = { date: "2028-05-15", basis: { kind: "fact" as const, key: "graduation_date", scope: "global" } };
  const school = "University of Example, Springfield";
  const colleges = ["University of Example--Springfield (IL)", "Example College (NY)", "Other"];
  const followUp = (required: boolean) =>
    control({ tag: "input", type: "text", id: "question_other", label: `If you selected other, please specify which one${required ? "*" : ""}`, required });

  it("chooses the school from a list whose options carry a US state code, and fills the \"if other\" follow-up with N/A", () => {
    const list = control({ tag: "select", id: "question_college", label: "Which college did you attend?*", required: true, options: colleges });
    const required = plan([list, followUp(true)], { education: { school } });
    expect(actions(required)).toEqual({ question_college: ["choose", "University of Example--Springfield (IL)"], question_other: ["fill", "N/A"] });
    expect(required.decisions[1]!.basis).toBeNull();
    expect(required.pauses).toEqual([]);
    expect(actions(plan([list, followUp(false)], { education: { school } }))["question_other"]).toEqual(["skip", null]);
    // A list that paused leaves its follow-up to the candidate.
    const paused = plan([list, followUp(true)], { education: { school: "Fixture Institute of Technology" } });
    expect(actions(paused)).toEqual({ question_college: ["pause", null], question_other: ["pause", null] });
    // A type-ahead's pick is settled only when it runs: its follow-up is never N/A.
    const searched = control({ tag: "select", id: "question_college", label: "Which college did you attend?*", required: true, widget: "autocomplete", options: colleges });
    const typed = plan([searched, followUp(true)], { education: { school } });
    expect(actions(typed)["question_other"]).toEqual(["pause", null]);
  });

  it("answers the degree being pursued like a Degree list", () => {
    const degree = control({
      tag: "select", id: "question_degree", label: "What degree level are you currently pursuing, or have you most recently completed?*", required: true,
      options: ["No Degree", "Associate's", "Bachelor's", "Master's"]
    });
    expect(actions(plan([degree], { education: { degree: "Bachelor of Science" } }))).toEqual({ question_degree: ["choose", "Bachelor's"] });
  });

  it("answers a graduation year from the year of the graduation date", () => {
    const resolution = { status: "RESOLVED", key: "graduation_date", scope: "global", display: "2028-05-15", value: "2028-05-15" } as const;
    const years = control({
      tag: "select", id: "question_year", label: "What is your expected graduation year (or year of most recent graduation)?*", required: true,
      options: ["2026", "2027", "2028", "2029"]
    });
    const typed = control({ tag: "input", type: "text", id: "question_typed_year", label: "Expected graduation year*", required: true });
    const result = plan([years, typed], { resolutions: new Map([["question_year", resolution], ["question_typed_year", resolution]]) });
    expect(actions(result)).toEqual({ question_year: ["choose", "2028"], question_typed_year: ["fill", "2028"] });
    expect(result.decisions[0]!.basis).toEqual({ kind: "fact", key: "graduation_date", scope: "global" });
  });

  it("fills the profile LinkedIn URL into a sentence-style LinkedIn label", () => {
    const linkedin = control({ tag: "input", type: "text", id: "question_linkedin", label: "Please provide a link to your LinkedIn profile.*", required: true });
    const url = "https://www.linkedin.com/in/fixture-candidate";
    expect(actions(plan([linkedin], { profile: { linkedinUrl: url } }))).toEqual({ question_linkedin: ["fill", url] });
  });

  it("answers Yes to a current computer science student question only from the profile's field of study and a graduation still ahead", () => {
    const major = control({
      tag: "select", id: "question_cs", label: "Are you a current college student majoring in computer science or related field?*", required: true, options: ["Yes", "No"]
    });
    const standing = (today: string) => ({ acceptDataConsent: false, signAttestations: false, today });
    const current = plan([major], { profile: { fieldOfStudy: "Computer Science" }, education: { graduation }, standing: standing("2026-11-24") });
    expect(actions(current)).toEqual({ question_cs: ["choose", "Yes"] });
    expect(current.decisions[0]!.basis).toEqual({ kind: "profile", field: "fieldOfStudy" });
    expect(actions(plan([major], { profile: { fieldOfStudy: "Computer Science" }, education: { graduation }, standing: standing("2028-06-01") })))
      .toEqual({ question_cs: ["pause", null] });
    expect(actions(plan([major], { profile: { fieldOfStudy: "Economics" }, education: { graduation }, standing: standing("2026-11-24") })))
      .toEqual({ question_cs: ["pause", null] });
  });

  it("compares a school a question names with the profile's school: another institution No, the same school Yes while enrolled, anything ambiguous paused (Track 57)", () => {
    const enrolledAt = (today: string, schoolName = "Example State University") => ({
      education: { school: schoolName, degree: "B.S. Computer Science", graduation: { date: "2030-05-15", basis: { kind: "profile" as const, field: "graduationDate" } } },
      standing: { acceptDataConsent: false, signAttestations: false, today }
    });
    const question = (label: string, tag: "select" | "radio" = "select") => tag === "radio"
      ? control({ tag: "input", type: "radio", id: "question_school", label, required: true, options: ["Yes", "No"] })
      : control({ tag: "select", id: "question_school", label, required: true, options: ["Yes", "No"] });
    const answer = (label: string, today = "2026-11-24", schoolName?: string, tag: "select" | "radio" = "select") =>
      actions(plan([question(label, tag)], enrolledAt(today, schoolName))).question_school;

    const other = plan([question("Are you an undergrad, masters or PhD student from the Northwind Institute of Technology?", "radio")], enrolledAt("2026-11-24"));
    expect(actions(other)).toEqual({ question_school: ["choose", "No"] });
    expect(other.decisions[0]!.basis).toEqual({ kind: "profile", field: "school" });
    expect(answer("Are you currently enrolled at Example State University?*")).toEqual(["choose", "Yes"]);
    expect(answer("Are you currently enrolled at Example State University?*", "2031-01-01")).toEqual(["pause", null]);
    expect(answer("Are you an undergrad, masters or PhD student from Example State University?")).toEqual(["choose", "Yes"]);
    expect(answer("Are you a PhD student at Example State University?")).toEqual(["pause", null]);
    expect(answer("Are you a PhD student at Westfield College?")).toEqual(["choose", "No"]);
    expect(answer("Are you a full-time student at Example State University?")).toEqual(["pause", null]);
    expect(answer("Are you a full-time student at Westfield College?")).toEqual(["choose", "No"]);

    // Ambiguous names, two schools, past wording, and no named school wait for the candidate.
    expect(answer("Are you a student at Example University?")).toEqual(["pause", null]);
    expect(answer("Are you a student at ESU University?")).toEqual(["pause", null]);
    expect(answer("Are you currently enrolled at the University of Example?", "2026-11-24", "University of Example, Springfield")).toEqual(["pause", null]);
    expect(answer("Are you a student at Northwind University or Example State University?")).toEqual(["pause", null]);
    expect(answer("Have you attended Northwind University?")).toEqual(["pause", null]);
    expect(answer("Are you currently enrolled in a degree program?")).toEqual(["pause", null]);

    // A saved answer for the question comes first.
    const label = "Are you a PhD student at Westfield College?";
    const remembered = plan([question(label)], {
      ...enrolledAt("2026-11-24"),
      resolutions: new Map([["question_school", { status: "REMEMBERED_ANSWER", answerId: "answer-1", answer: "Yes", answerKey: "yes", answerKind: "option" } as const]])
    });
    expect(actions(remembered)).toEqual({ question_school: ["choose", "Yes"] });
    expect(remembered.decisions[0]!.basis?.kind).toBe("question_answer");
  });

  it("offers package answers only to text boxes, never to a choice or a background-check question", () => {
    const packageAnswers = [{ prompt: "Describe your most relevant experience.", text: "Relevant experience: fixture robotics project." }];
    const years = (required: boolean) => control({
      tag: "select", id: "question_years", label: `How many years of relevant experience do you have?${required ? "*" : ""}`, required, options: ["0-1", "2-3", "4+"]
    });
    const required = plan([years(true)], { packageAnswers });
    expect(actions(required)).toEqual({ question_years: ["pause", null] });
    expect(required.pauses[0]!.question).not.toContain("known answer");
    expect(actions(plan([years(false)], { packageAnswers }))).toEqual({ question_years: ["skip", null] });
    const python = control({ tag: "input", type: "radio", id: "python", label: "Do you have experience with Python?", required: true, options: ["Yes", "No"] });
    const choice = plan([python], { packageAnswers });
    expect(actions(choice)).toEqual({ python: ["pause", null] });
    expect(choice.pauses[0]!.question).toBe('How should "Do you have experience with Python?" be answered?');
    expect(choice.decisions[0]!.basis?.kind).not.toBe("package-answer");
    const background = control({ tag: "input", type: "text", id: "question_background", label: "Do you consent to a background check? Please explain.*", required: true });
    const decision = plan([background], { packageAnswers }).decisions[0]!;
    expect(decision.basis?.kind).not.toBe("package-answer");
  });

  it("gives a package answer only to a question that asks the same thing, never on a keyword", () => {
    // The writer's three prompts (packages/writer package-builder), with synthetic texts.
    const packageAnswers = [
      { prompt: "Why are you interested in this role?", text: "INTEREST-ANSWER" },
      { prompt: "Describe your most relevant experience.", text: "EXPERIENCE-ANSWER" },
      { prompt: "What is your work authorization and availability?", text: "AUTHORIZATION-ANSWER" }
    ];
    const box = (label: string, index: number, tag: "input" | "textarea") =>
      control(tag === "input" ? { tag, type: "text", id: `q${index}`, label, required: true } : { tag, id: `q${index}`, label, required: true });
    const answerFor = (label: string, tag: "input" | "textarea" = "textarea") => {
      const decision = plan([box(label, 0, tag)], { packageAnswers }).decisions[0]!;
      return decision.basis?.kind === "package-answer" ? decision.value : decision.action;
    };
    const matches: Array<[string, string]> = [
      ["Why are you interested in this role?*", "INTEREST-ANSWER"],
      ["Why are you interested in the Summer Research Intern position at Fixture Labs?", "INTEREST-ANSWER"],
      ["Why do you want to work at Fixture Robotics?", "INTEREST-ANSWER"],
      ["Why do you want to work here?", "INTEREST-ANSWER"],
      ["Why do you want to join Fixture Robotics?", "INTEREST-ANSWER"],
      ["Why do you want this role?", "INTEREST-ANSWER"],
      ["Why this internship?", "INTEREST-ANSWER"],
      ["What interests you about this position?", "INTEREST-ANSWER"],
      ["What motivates you to apply? (200 words max)", "INTEREST-ANSWER"],
      ["Why are you interested in joining Fixture Labs\u2019 research team?", "INTEREST-ANSWER"],
      ["Describe your most relevant experience.", "EXPERIENCE-ANSWER"],
      ["Please describe your relevant background for this role", "EXPERIENCE-ANSWER"],
      ["What relevant experience do you have?", "EXPERIENCE-ANSWER"],
      ["What is your work authorization and availability?", "AUTHORIZATION-ANSWER"],
      ["Work authorization status", "AUTHORIZATION-ANSWER"]
    ];
    for (const [label, expected] of matches) expect([label, answerFor(label)]).toEqual([label, expected]);
    expect(answerFor("Why are you interested in this role?", "input")).toBe("INTEREST-ANSWER");

    // Required questions a canned answer does not answer pause for the candidate instead.
    const pauses = [
      // The SemiAnalysis-style technical question (Track 10 evidence) and its variants.
      "Why does CPX change prefill economics compared with an NVL72 rack?",
      "Why are you interested in CPX vs NVL72 for long-context prefill?",
      "Why would a disaggregated CPX prefill tier beat NVL72 on cost per token?",
      "Which company do you think is best placed to win AI inference, and why?",
      "Which company's accelerator roadmap do you find most compelling?",
      "Describe a project where you used Python and why you chose it.",
      "Describe a project where you used CUDA, including the problem, your role, and the result.",
      "How many years of experience do you have with Python?",
      "How many years of relevant experience do you have?",
      "Explain why memory bandwidth limits decode throughput.",
      "Explain why you chose your major.",
      "What is your opinion of our latest report on token pricing?",
      "Describe your experience with Kubernetes.",
      "Tell us about a time you disagreed with a teammate and why.",
      "Please share a link to a project you are proud of.",
      "What company are you currently working for?",
      "Are you authorized to work in Canada?",
      "When can you start, and how many hours per week are you available?",
      "Do you consent to a background check? Please explain."
    ];
    for (const label of pauses) expect([label, answerFor(label)]).toEqual([label, "pause"]);
  });

  it("declines a marketing opt-in list under either standing setting, even with a clipped label, and never an application-status question", () => {
    const marketing = control({
      tag: "select", id: "question_marketing", required: true, options: ["Yes", "No"],
      label: "You can choose to receive recruitment marketing communications from Fixture Robotics, including updates on job opportunities, career advice, and events. T…"
    });
    const on = { acceptDataConsent: true, signAttestations: true, today: "2026-11-24" };
    const declined = plan([marketing], { standing: on });
    expect(actions(declined)).toEqual({ question_marketing: ["choose", "No"] });
    expect(declined.decisions[0]!.basis).toBeNull();
    const mixed = control({
      tag: "select", id: "question_texts", required: true, options: ["Yes", "No"],
      label: "Do you want to receive marketing emails and text messages about your application status?*"
    });
    expect(actions(plan([mixed], { standing: on }))).toEqual({ question_texts: ["pause", null] });
    expect(actions(plan([marketing], { standing: { acceptDataConsent: false, signAttestations: false, today: "2026-11-24" } })))
      .toEqual({ question_marketing: ["pause", null] });
  });
});

describe("post-submit outcomes", () => {
  const GREENHOUSE = "https://job-boards.greenhouse.io/fixturerobotics/jobs/1000001";

  it("counts the longer confirmation phrases apart from a description's thank you", () => {
    expect(readNewConfirmation("Thank you for your interest in Fixture Robotics.", "Thank you for your interest in Fixture Robotics.\nThank you for applying."))
      .toBe("Thank you for applying");
    expect(readNewConfirmation("Thank you for your interest.", "We’ve received your application and will be in touch.")).toBe("We’ve received your application");
    expect(readNewConfirmation("Thank you for your interest.", "We've received your application.")).toBe("We've received your application");
    expect(readNewConfirmation("Thank you for your interest.", "We have received your application.")).toBe("We have received your application");
    expect(readNewConfirmation("Thank you for applying.", "Thank you for applying.")).toBe(null);
  });

  it("recognizes Greenhouse and Lever confirmation URLs, only when new after the click", () => {
    expect(isConfirmationUrl(`${GREENHOUSE}/confirmation`)).toBe(true);
    expect(isConfirmationUrl(`${GREENHOUSE}/confirmation/`)).toBe(true);
    expect(isConfirmationUrl(`${GREENHOUSE}?confirmation=true`)).toBe(true);
    expect(isConfirmationUrl(GREENHOUSE)).toBe(false);
    expect(isConfirmationUrl("https://boards.greenhouse.io/fixturerobotics/jobs/1000001/confirmation")).toBe(true);
    expect(isConfirmationUrl("https://jobs.lever.co/fixturerobotics/00000000-0000-4000-8000-0000000000b1/thanks")).toBe(true);
    expect(isConfirmationUrl("https://jobs.lever.co/fixturerobotics/00000000-0000-4000-8000-0000000000b1/apply")).toBe(false);
    expect(isConfirmationUrl("https://example.com/jobs/1/confirmation")).toBe(false);
    expect(isConfirmationUrl("https://example.com/jobs/1?confirmation=1")).toBe(false);
    expect(isConfirmationUrl("not a url")).toBe(false);

    // Ashby confirmation URLs
    expect(isConfirmationUrl("https://jobs.ashbyhq.com/fixturerobotics/00000000-0000-4000-8000-0000000000a1/confirmation")).toBe(true);
    expect(isConfirmationUrl("https://jobs.ashbyhq.com/fixturerobotics/00000000-0000-4000-8000-0000000000a1/submitted")).toBe(true);
    expect(isConfirmationUrl("https://jobs.ashbyhq.com/fixturerobotics/00000000-0000-4000-8000-0000000000a1/application?submitted=1")).toBe(true);

    // Dover confirmation URLs
    expect(isConfirmationUrl("https://jobs.dover.com/job/00000000-0000-4000-8000-0000000000d1/applied")).toBe(true);
    expect(isConfirmationUrl("https://app.dover.io/apply/job/00000000-0000-4000-8000-0000000000d1/confirmation")).toBe(true);
    expect(isConfirmationUrl("https://jobs.dover.com/job/00000000-0000-4000-8000-0000000000d1?applied=true")).toBe(true);

    expect(readNewConfirmationUrl(GREENHOUSE, `${GREENHOUSE}/confirmation?token=abc#top`)).toBe(`${GREENHOUSE}/confirmation`);
    expect(readNewConfirmationUrl(`${GREENHOUSE}/confirmation`, `${GREENHOUSE}/confirmation`)).toBe(null);
    expect(readNewConfirmationUrl(GREENHOUSE, GREENHOUSE)).toBe(null);
    expect(readNewConfirmationUrl(GREENHOUSE, `${GREENHOUSE}?confirmation=true`)).toBe(GREENHOUSE);
  });

  it("strips a URL's query and fragment", () => {
    expect(stripUrlQuery(`${GREENHOUSE}?a=1#b`)).toBe(GREENHOUSE);
    expect(stripUrlQuery("::nonsense")).toBe("");
  });

  it("classifies an unconfirmed click deterministically", () => {
    const school: InvalidField = { ref: "school--0", label: "School", error: "This field is required." };
    expect(classifyUnconfirmed({ invalidBefore: [], invalidAfter: [school], submitShown: true, alertText: "" })).toBe("field-errors");
    expect(classifyUnconfirmed({ invalidBefore: [], invalidAfter: [school], submitShown: true, alertText: "This field is required." })).toBe("field-errors");
    expect(classifyUnconfirmed({ invalidBefore: [], invalidAfter: [school], submitShown: false, alertText: "" })).toBe("unknown");
    expect(classifyUnconfirmed({ invalidBefore: [], invalidAfter: [school], submitShown: false, alertText: "There was a problem" })).toBe("refused");
    expect(classifyUnconfirmed({ invalidBefore: [school], invalidAfter: [school], submitShown: true, alertText: "" })).toBe("unknown");
    expect(classifyUnconfirmed({ invalidBefore: [school], invalidAfter: [school], submitShown: true, alertText: "There was a problem" })).toBe("refused");
    expect(classifyUnconfirmed({ invalidBefore: [], invalidAfter: [], submitShown: true, alertText: "There was a problem" })).toBe("refused");
    expect(classifyUnconfirmed({ invalidBefore: [], invalidAfter: [], submitShown: true, alertText: "  " })).toBe("unknown");

    // Benign title banners (e.g. Rippling aria-live banner) do not trigger refusal
    expect(classifyUnconfirmed({ invalidBefore: [], invalidAfter: [], submitShown: true, alertText: "Apply - Engineering Intern (Summer 2027)" })).toBe("unknown");
    expect(classifyUnconfirmed({ invalidBefore: [], invalidAfter: [], submitShown: false, alertText: "Application: Software Engineer" })).toBe("unknown");
    expect(classifyUnconfirmed({ invalidBefore: [], invalidAfter: [], submitShown: true, alertText: "Engineering Intern", pageTitle: "Engineering Intern" })).toBe("unknown");
    expect(classifyUnconfirmed({ invalidBefore: [], invalidAfter: [], submitShown: true, alertText: "Application error: Submission failed" })).toBe("refused");
  });

  it("distinguishes genuine refusal alerts from benign page headers and titles", () => {
    // Rippling title banner cases
    expect(isRefusalAlert("Apply - Engineering Intern (Summer 2027)")).toBe(false);
    expect(isRefusalAlert("Apply – Product Design Intern")).toBe(false);
    expect(isRefusalAlert("Application: Software Engineer")).toBe(false);
    expect(isRefusalAlert("Apply")).toBe(false);
    expect(isRefusalAlert("")).toBe(false);
    expect(isRefusalAlert("   ")).toBe(false);

    // Matching page title / heading
    expect(isRefusalAlert("Engineering Intern (Summer 2027)", { pageTitle: "Engineering Intern (Summer 2027) - Rippling" })).toBe(false);
    expect(isRefusalAlert("Senior Backend Engineer", { headingText: "Senior Backend Engineer" })).toBe(false);

    // Real refusal alerts
    expect(isRefusalAlert("There was a problem")).toBe(true);
    expect(isRefusalAlert("This field is required.")).toBe(true);
    expect(isRefusalAlert("An error occurred while submitting your application.")).toBe(true);
    expect(isRefusalAlert("Submission failed. Please try again.")).toBe(true);
    expect(isRefusalAlert("You have already applied for this position.")).toBe(true);
    expect(isRefusalAlert("Application error: invalid input")).toBe(true);
    expect(isRefusalAlert("Application deadline has passed")).toBe(true);
  });

  it("checks whether dialog closure is confirmed on Dover or Ashby", () => {
    expect(isDoverOrAshby("https://jobs.dover.com/job/123")).toBe(true);
    expect(isDoverOrAshby("https://app.dover.io/apply/job/123")).toBe(true);
    expect(isDoverOrAshby("https://jobs.ashbyhq.com/company/123/application")).toBe(true);
    expect(isDoverOrAshby("https://careers.example.com/job?ashby_jid=123")).toBe(true);
    expect(isDoverOrAshby("https://example.com/apply", "dover")).toBe(true);
    expect(isDoverOrAshby("https://example.com/apply", "ashby")).toBe(true);
    expect(isDoverOrAshby("https://example.com/apply")).toBe(false);

    // Closed dialog on Dover/Ashby without errors/refusals is confirmed
    expect(isDialogCloseConfirmed({ dialogClosed: true, invalidBefore: [], invalidAfter: [], submitShown: false, alertText: "", isDoverOrAshby: true })).toBe(true);
    // Closed dialog on unknown ATS is not confirmed
    expect(isDialogCloseConfirmed({ dialogClosed: true, invalidBefore: [], invalidAfter: [], submitShown: false, alertText: "", isDoverOrAshby: false })).toBe(false);
    // Field errors or refusals prevent confirmation
    const school: InvalidField = { ref: "school--0", label: "School", error: "This field is required." };
    expect(isDialogCloseConfirmed({ dialogClosed: true, invalidBefore: [], invalidAfter: [school], submitShown: true, alertText: "", isDoverOrAshby: true })).toBe(false);
    expect(isDialogCloseConfirmed({ dialogClosed: true, invalidBefore: [], invalidAfter: [], submitShown: false, alertText: "Submission failed", isDoverOrAshby: true })).toBe(false);
    // Dialog not closed
    expect(isDialogCloseConfirmed({ dialogClosed: false, invalidBefore: [], invalidAfter: [], submitShown: false, alertText: "", isDoverOrAshby: true })).toBe(false);
  });

  type OutcomePage = {
    urlAfter?: string;
    bodyAfter?: string;
    throwOnce?: boolean;
    invalidBefore?: InvalidField[];
    invalidAfter?: InvalidField[];
    submitShown?: boolean;
    alertAfter?: string;
    challengeAfter?: boolean;
    dialogOpen?: boolean;
  };
  const outcomePage = (options: OutcomePage): BrowserPage => {
    let clicked = false;
    let thrown = false;
    const page: BrowserPage = {
      url: () => (clicked && options.urlAfter ? options.urlAfter : `${GREENHOUSE}?gh_src=fixture`),
      title: async () => "Apply",
      collectControls: async () => [],
      bodyText: async () => {
        if (clicked && options.throwOnce && !thrown) {
          thrown = true;
          throw new Error("Execution context was destroyed");
        }
        return clicked && options.bodyAfter !== undefined ? options.bodyAfter : "Robotics Software Intern. Thank you for your interest. Submit application";
      },
      fillField: async () => {},
      chooseOption: async () => {},
      setChecked: async () => {},
      uploadFile: async () => {},
      clickSubmit: async () => { clicked = true; },
      screenshot: async () => {},
      close: async () => {},
      invalidFields: async () => (clicked ? options.invalidAfter ?? [] : options.invalidBefore ?? []),
      submitControlShown: async () => options.submitShown ?? true,
      alertText: async () => (clicked ? options.alertAfter ?? "" : ""),
      visibleChallenge: async () => (clicked && options.challengeAfter ? { kind: "recaptcha", detail: "a reCAPTCHA image challenge" } : null)
    };
    if (options.dialogOpen !== undefined) page.applicationDialogOpen = async () => (clicked ? options.dialogOpen! : true);
    return page;
  };
  const fast = { timeoutMs: 20, pollMs: 1 };

  it("confirms by a new Greenhouse confirmation URL", async () => {
    await expect(submitAndConfirm(outcomePage({ urlAfter: `${GREENHOUSE}/confirmation`, bodyAfter: "" }), fast))
      .resolves.toBe(`Confirmation page: ${GREENHOUSE}/confirmation`);
    await expect(submitAndConfirm(outcomePage({ urlAfter: `${GREENHOUSE}/confirmation`, bodyAfter: "Thank you for your interest." }), fast))
      .resolves.toBe("Thank you for your interest.");
  });

  it("keeps waiting when a read fails during navigation", async () => {
    await expect(submitAndConfirm(outcomePage({ throwOnce: true, bodyAfter: "Application submitted" }), { timeoutMs: 500, pollMs: 1 }))
      .resolves.toContain("Application submitted");
  });

  it("holds new field errors for input, without page text in the message", async () => {
    const school: InvalidField = { ref: "school--0", label: "School", error: "This field is required." };
    const error = await submitAndConfirm(outcomePage({ invalidAfter: [school], alertAfter: "This field is required." }), fast).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubmissionNeedsInput);
    expect(error).toBeInstanceOf(SubmissionHeld);
    const held = error as SubmissionNeedsInput;
    expect(held.invalidFields).toEqual([school]);
    expect(held.evidence?.outcome).toBe("field-errors");
    expect(held.evidence?.url).toBe(GREENHOUSE);
    expect(held.message).toContain("marked 1 field(s) invalid");
    expect(held.message).not.toContain("This field is required");
    expect(held.message).not.toContain("School");
  });

  it("does not treat invalid fields that were already there as field errors", async () => {
    const school: InvalidField = { ref: "school--0", label: "School", error: "This field is required." };
    const error = await submitAndConfirm(outcomePage({ invalidBefore: [school], invalidAfter: [school] }), fast).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubmissionUnconfirmed);
    expect((error as SubmissionUnconfirmed).evidence.outcome).toBe("unknown");
    const gone = await submitAndConfirm(outcomePage({ invalidAfter: [school], submitShown: false }), fast).catch((caught: unknown) => caught);
    expect(gone).toBeInstanceOf(SubmissionUnconfirmed);
  });

  it("refuses on a banner and holds a challenge after the click, with evidence", async () => {
    const refused = await submitAndConfirm(outcomePage({ alertAfter: "There was a problem submitting your application." }), fast).catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(SubmissionRefused);
    expect((refused as SubmissionRefused).message).toBe("The site did not accept the submission (\"There was a problem submitting your application.\"). The run is not marked submitted; check the application on the site before retrying.");
    expect((refused as SubmissionRefused).evidence?.outcome).toBe("refused");
    expect((refused as SubmissionRefused).evidence?.alertText).toBe("There was a problem submitting your application.");
    const challenged = await submitAndConfirm(outcomePage({ challengeAfter: true }), fast).catch((caught: unknown) => caught);
    expect(challenged).toBeInstanceOf(SubmissionChallenged);
    expect((challenged as SubmissionChallenged).evidence?.outcome).toBe("challenged");
    expect((challenged as SubmissionChallenged).evidence?.challenge).toBe("a reCAPTCHA image challenge");
  });

  it("fails closed on nothing, with the same messages and query-stripped evidence", async () => {
    const closed = await submitAndConfirm(outcomePage({ dialogOpen: false }), fast).catch((caught: unknown) => caught);
    expect(closed).toBeInstanceOf(SubmissionUnconfirmed);
    expect(closed).not.toBeInstanceOf(SubmissionHeld);
    expect((closed as Error).message).toBe("The submit button was clicked and the application dialog closed, but no confirmation text was recognized. Check the application on the site before retrying; the run is not marked submitted.");
    const evidence = postSubmitEvidenceOf(closed);
    expect(evidence?.outcome).toBe("unknown");
    expect(evidence?.url).toBe(GREENHOUSE);
    expect(evidence?.bodyText).toContain("Submit application");
    const open = await submitAndConfirm(outcomePage({}), fast).catch((caught: unknown) => caught);
    expect(open).toBeInstanceOf(SubmissionUnconfirmed);
    expect((open as Error).message).toBe("The submit button was clicked but no new confirmation appeared. Check the application on the site before retrying; the run is not marked submitted.");
  });

  describe("Greenhouse's emailed security code", () => {
    // Fictional codes; the step's wording follows third-party descriptions, not a capture.
    const CODE = "K7QPZXMW";
    const STEP_TEXT = "Robotics Software Intern. We sent an 8-character security code to your email address. Enter it below, then submit your application again.";
    const BEFORE_TEXT = "Robotics Software Intern. Thank you for your interest. Submit application";

    it("recognizes the step only from new code inputs plus text about a code sent by email", () => {
      expect(isSecurityCodeStep({ codeInputsBefore: 0, codeInputsAfter: 8, bodyText: STEP_TEXT })).toBe(true);
      expect(isSecurityCodeStep({ codeInputsBefore: 0, codeInputsAfter: 1, bodyText: "Check your inbox for the verification code." })).toBe(true);
      expect(isSecurityCodeStep({ codeInputsBefore: 8, codeInputsAfter: 8, bodyText: STEP_TEXT })).toBe(false);
      expect(isSecurityCodeStep({ codeInputsBefore: 0, codeInputsAfter: 0, bodyText: STEP_TEXT })).toBe(false);
      expect(isSecurityCodeStep({ codeInputsBefore: 0, codeInputsAfter: 8, bodyText: "Robotics Software Intern. Submit application" })).toBe(false);
    });

    it("scrubs the code from every text, in any case, and marks the evidence", () => {
      expect(scrubSecret(`Code ${CODE} and ${CODE.toLowerCase()}.`, CODE)).toBe("Code [code] and [code].");
      expect(scrubSecret("a.b+c", "a.b+c")).toBe("[code]");
      expect(scrubSecret("axb", "a.b")).toBe("axb");
      expect(scrubSecret(`keep ${CODE}`, null)).toBe(`keep ${CODE}`);
      const evidence: PostSubmitEvidence = {
        outcome: "unknown", url: `${GREENHOUSE}/${CODE}`, bodyText: `Typed ${CODE}`, alertText: `Wrong ${CODE}`, challenge: `a ${CODE}`,
        invalidFields: [{ ref: `ref-${CODE}`, label: `Label ${CODE}`, error: `Error ${CODE}` }, { ref: null, label: "Plain", error: "Plain" }]
      };
      const scrubbed = withoutSecret(evidence, CODE);
      expect(JSON.stringify(scrubbed)).not.toContain(CODE);
      expect(scrubbed).toMatchObject({ securityCodeEntered: true, url: `${GREENHOUSE}/[code]`, bodyText: "Typed [code]", alertText: "Wrong [code]", challenge: "a [code]" });
      expect(scrubbed.invalidFields).toEqual([{ ref: "ref-[code]", label: "Label [code]", error: "Error [code]" }, { ref: null, label: "Plain", error: "Plain" }]);
      expect(withoutSecret({ ...evidence, challenge: null }, CODE).challenge).toBe(null);
    });

    it("knows Greenhouse's job-board hosts", () => {
      expect(isGreenhouseBoardUrl(GREENHOUSE)).toBe(true);
      expect(isGreenhouseBoardUrl("https://boards.greenhouse.io/fixturerobotics/jobs/1")).toBe(true);
      expect(isGreenhouseBoardUrl("https://job-boards.eu.greenhouse.io/fixturerobotics/jobs/1")).toBe(true);
      expect(isGreenhouseBoardUrl("https://jobs.lever.co/fixturerobotics/1/apply")).toBe(false);
      expect(isGreenhouseBoardUrl("https://greenhouse.io.example.test/jobs/1")).toBe(false);
      expect(isGreenhouseBoardUrl("not a url")).toBe(false);
    });

    type CodeStepOptions = {
      /** Code inputs already on the page before the click. */
      inputsBefore?: number;
      /** The confirmation echoes the typed code (to prove scrubbing). */
      echo?: boolean;
      /** The step stays after the code was typed. */
      stillAsks?: boolean;
      throwNotEntered?: boolean;
      /** submitSecurityCode throws a plain error; the confirmation still appears. */
      throwPlain?: boolean;
    };
    const codeStepPage = (options: CodeStepOptions = {}) => {
      let clicked = false;
      let typed: string | null = null;
      const record = { calls: 0, matched: false };
      const accepted = () => typed !== null && !options.stillAsks;
      const page: BrowserPage = {
        url: () => `${GREENHOUSE}?gh_src=fixture`,
        title: async () => "Apply",
        collectControls: async () => [],
        bodyText: async () => {
          if (accepted()) return `Thank you for applying. Your application has been received.${options.echo ? ` Reference ${typed}.` : ""}`;
          if (clicked) return `${STEP_TEXT}${typed !== null && options.echo ? ` You typed ${typed}.` : ""}`;
          return BEFORE_TEXT;
        },
        fillField: async () => {},
        chooseOption: async () => {},
        setChecked: async () => {},
        uploadFile: async () => {},
        clickSubmit: async () => { clicked = true; },
        screenshot: async () => {},
        close: async () => {},
        invalidFields: async () => [],
        submitControlShown: async () => true,
        alertText: async () => "",
        visibleChallenge: async () => null,
        securityCodeInputs: async () => (accepted() ? 0 : clicked ? 8 : options.inputsBefore ?? 0),
        submitSecurityCode: async (code) => {
          record.calls += 1;
          record.matched = code === CODE;
          if (options.throwNotEntered) throw new SecurityCodeNotEntered("The security code field did not take the code.");
          typed = code;
          if (options.throwPlain) throw new Error("The security code's submit click failed.");
        }
      };
      return { page, record };
    };
    const lookupOf = (result: SecurityCodeLookupResult) => {
      const requests: Array<{ url: string; clickedAt: Date }> = [];
      const lookup: SecurityCodeLookup = async (request) => { requests.push(request); return result; };
      return { lookup, requests };
    };

    it("enters the one emailed code, clicks the step's submit, and returns the confirmation without the code", async () => {
      const { page, record } = codeStepPage({ echo: true });
      const { lookup, requests } = lookupOf({ kind: "found", code: CODE });
      const confirmation = await submitAndConfirm(page, { ...fast, securityCode: lookup });
      expect(confirmation).toContain("Thank you for applying");
      expect(confirmation).toContain("Reference [code].");
      expect(confirmation.includes(CODE)).toBe(false);
      expect(record).toEqual({ calls: 1, matched: true });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe(GREENHOUSE);
      expect(requests[0]!.clickedAt).toBeInstanceOf(Date);
    });

    it.each<[string, SecurityCodeLookupResult, SecurityCodeHoldKind]>([
      ["none", { kind: "none" }, "none"],
      ["ambiguous", { kind: "ambiguous" }, "ambiguous"],
      ["no-mailbox", { kind: "no-mailbox" }, "no-mailbox"],
      ["unavailable", { kind: "unavailable" }, "unavailable"],
      ["unsupported", { kind: "unsupported" }, "unsupported"]
    ])("holds the run when the lookup finds %s, without touching the step", async (_name, result, kind) => {
      const { page, record } = codeStepPage();
      const error = await submitAndConfirm(page, { ...fast, securityCode: lookupOf(result).lookup }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SubmissionCodeNotFound);
      expect(error).toBeInstanceOf(SubmissionHeld);
      expect((error as Error).message).toBe(securityCodeHoldMessage(kind));
      const evidence = postSubmitEvidenceOf(error);
      expect(evidence?.outcome).toBe("verification-code");
      expect(evidence?.url).toBe(GREENHOUSE);
      expect(evidence?.securityCodeEntered).toBeFalsy();
      expect(record.calls).toBe(0);
    });

    it("holds as no-mailbox without a lookup, and as unavailable when the lookup rejects", async () => {
      const bare = codeStepPage();
      const noLookup = await submitAndConfirm(bare.page, fast).catch((caught: unknown) => caught);
      expect(noLookup).toBeInstanceOf(SubmissionCodeNotFound);
      expect((noLookup as Error).message).toBe(securityCodeHoldMessage("no-mailbox"));
      expect(bare.record.calls).toBe(0);
      const rejecting = codeStepPage();
      const rejected = await submitAndConfirm(rejecting.page, { ...fast, securityCode: async () => { throw new Error("mail server text"); } }).catch((caught: unknown) => caught);
      expect(rejected).toBeInstanceOf(SubmissionCodeNotFound);
      expect((rejected as Error).message).toBe(securityCodeHoldMessage("unavailable"));
      expect((rejected as Error).message).not.toContain("mail server text");
    });

    it("holds as not-entered when the field does not take the code, with scrubbed evidence", async () => {
      const { page, record } = codeStepPage({ throwNotEntered: true });
      const error = await submitAndConfirm(page, { ...fast, securityCode: lookupOf({ kind: "found", code: CODE }).lookup }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SubmissionCodeNotFound);
      expect((error as Error).message).toBe(securityCodeHoldMessage("not-entered"));
      expect(postSubmitEvidenceOf(error)).toMatchObject({ outcome: "verification-code", securityCodeEntered: true });
      expect(JSON.stringify(postSubmitEvidenceOf(error)).includes(CODE)).toBe(false);
      expect(record.calls).toBe(1);
    });

    it("keeps waiting after a plain error from the step's submit and recognizes the confirmation", async () => {
      const { page, record } = codeStepPage({ throwPlain: true });
      await expect(submitAndConfirm(page, { ...fast, securityCode: lookupOf({ kind: "found", code: CODE }).lookup })).resolves.toContain("Thank you for applying");
      expect(record.calls).toBe(1);
    });

    it("fails closed when the step is still shown after the code was typed, without the code in the evidence", async () => {
      const { page, record } = codeStepPage({ stillAsks: true, echo: true });
      const error = await submitAndConfirm(page, { ...fast, securityCode: lookupOf({ kind: "found", code: CODE }).lookup }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SubmissionUnconfirmed);
      expect(error).not.toBeInstanceOf(SubmissionHeld);
      expect((error as Error).message).toBe(SECURITY_CODE_STILL_ASKED);
      const evidence = postSubmitEvidenceOf(error);
      expect(evidence?.outcome).toBe("verification-code");
      expect(evidence?.securityCodeEntered).toBe(true);
      expect(evidence?.bodyText).toContain("You typed [code].");
      expect(JSON.stringify(evidence).includes(CODE)).toBe(false);
      expect(record.calls).toBe(1);
    });

    it("is not a code step when the inputs were there before the click", async () => {
      const { page, record } = codeStepPage({ inputsBefore: 8 });
      const { lookup, requests } = lookupOf({ kind: "found", code: CODE });
      const error = await submitAndConfirm(page, { ...fast, securityCode: lookup }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SubmissionUnconfirmed);
      expect(postSubmitEvidenceOf(error)?.outcome).toBe("unknown");
      expect(requests).toHaveLength(0);
      expect(record.calls).toBe(0);
    });
  });

  describe("pauses for invalid fields", () => {
    const form = recognizeForm(GREENHOUSE, "Apply", [
      control({ tag: "input", type: "email", id: "email", label: "Email *" }),
      control({ tag: "select", id: "school--0", label: "School", options: ["Fixture State University"] }),
      control({ tag: "input", type: "text", id: "start-month-0", label: "Start date" }),
      control({ tag: "input", type: "text", id: "end-month-0", label: "Start date" }),
      control({ tag: "select", id: "gender", label: "Gender", options: ["Decline to self-identify"] })
    ]);
    const decision = (fieldId: string) => ({ fieldId, action: "fill" as const, value: "x", basis: null, reason: "planned", pause: null });

    it("pauses a field found by id, carrying the site's error text", () => {
      const held = invalidFieldPauses(form, [decision("school--0"), decision("email")], [], [{ ref: "school--0", label: "School", error: "This field is required." }]);
      expect(held.pauses).toEqual([expect.objectContaining({
        fieldId: "school--0", label: "School", question: "School: This field is required.", safeguard: false, sensitive: false,
        status: "open", fieldKind: "select", options: ["Fixture State University"]
      })]);
      expect(held.decisions.find((entry) => entry.fieldId === "school--0")).toMatchObject({ action: "pause", reason: "School: This field is required." });
      expect(held.decisions.find((entry) => entry.fieldId === "email")).toMatchObject({ action: "fill" });
      expect(held.decisions).toHaveLength(2);
    });

    it("matches a unique label ignoring case and required markers", () => {
      const held = invalidFieldPauses(form, [], [], [{ ref: null, label: "EMAIL ✱", error: "Enter a valid email." }]);
      expect(held.pauses[0]).toMatchObject({ fieldId: "email", question: "Email: Enter a valid email.", safeguard: false });
      expect(held.decisions).toEqual([expect.objectContaining({ fieldId: "email", action: "pause" })]);
    });

    it("turns an ambiguous or missing field into a site-error safeguard", () => {
      const held = invalidFieldPauses(form, [], [], [
        { ref: null, label: "Start date", error: "Required." },
        { ref: "portfolio", label: "Portfolio", error: "This field is required." }
      ]);
      expect(held.pauses.map((pause) => [pause.fieldId, pause.safeguard])).toEqual([["site-error-1", true], ["site-error-2", true]]);
      expect(held.pauses[1]!.question).toBe("Portfolio: This field is required.. The agent could not find this field on the form; fix it in your browser.");
      expect(held.decisions.every((entry) => entry.pause?.safeguard === true)).toBe(true);
    });

    it("marks an EEO field sensitive and replaces an existing pause for the field", () => {
      const existing = {
        fieldId: "gender", label: "Gender", question: "Old", suggestedKey: null, suggestedScope: null, safeguard: false,
        sensitive: true, upload: false, status: "answered" as const, answer: "Decline to self-identify", draft: null
      };
      const other = { ...existing, fieldId: "other", label: "Other" };
      const held = invalidFieldPauses(form, [], [existing, other], [{ ref: "gender", label: "Gender", error: "Please select an option." }]);
      expect(held.pauses).toHaveLength(2);
      expect(held.pauses.find((pause) => pause.fieldId === "other")).toEqual(other);
      expect(held.pauses.find((pause) => pause.fieldId === "gender")).toMatchObject({ status: "open", answer: null, sensitive: true, question: "Gender: Please select an option." });
    });
  });
});

describe("Ashby's answer saves and submit feedback", () => {
  const FAST = { timeoutMs: 50, pollMs: 1 };
  const quiet: AshbySubmitState = { busySeen: false, busyShown: false, failureText: "", spamCheck: false };

  function ashbyPage(options: {
    url?: string;
    state?: (clicks: number, reads: number) => AshbySubmitState;
    successAtClick?: number;
    successText?: string;
    /** Ashby's network record at the given click count (Track 22); without it the page has no network watch. */
    network?: (clicks: number) => AshbySubmitNetwork | null;
  } = {}) {
    const events: string[] = [];
    let clicks = 0;
    let reads = 0;
    const networkOf = options.network;
    const page: BrowserPage = {
      url: () => options.url ?? "https://jobs.ashbyhq.com/fixture/1/application",
      title: async () => "Apply",
      collectControls: async () => [],
      bodyText: async () => "Robotics Software Intern Submit Application",
      fillField: async () => {},
      chooseOption: async () => {},
      setChecked: async () => {},
      uploadFile: async () => {},
      clickSubmit: async () => {
        events.push("click");
        clicks += 1;
      },
      screenshot: async () => {},
      close: async () => {},
      successText: async () => (options.successAtClick !== undefined && clicks >= options.successAtClick ? options.successText ?? "Your application was successfully submitted." : ""),
      settleAshbySaves: async (ms) => {
        events.push(`settle:${ms}`);
      },
      ashbySubmitState: async () => {
        if (clicks > 0) reads += 1;
        return options.state ? options.state(clicks, reads) : quiet;
      },
      ...(networkOf
        ? {
          watchAshbyNetwork: async () => {
            events.push("watch");
          },
          ashbySubmitNetwork: async () => networkOf(clicks)
        }
        : {})
    };
    return { page, events, clicks: () => clicks };
  }

  it("settles Ashby's saves before the first click", async () => {
    const { page, events } = ashbyPage({ successAtClick: 1 });
    await expect(submitAndConfirm(page, FAST)).resolves.toContain("successfully submitted");
    expect(events.slice(0, 2)).toEqual([`settle:${ASHBY_SAVE_SETTLE_MS}`, "click"]);
  });

  it("clicks again once Ashby's busy notice is gone, never while it is shown", async () => {
    const { page, events } = ashbyPage({
      successAtClick: 2,
      state: (clicks, reads) => (clicks === 1 ? { ...quiet, busySeen: true, busyShown: reads <= 2 } : quiet)
    });
    await expect(submitAndConfirm(page, FAST)).resolves.toContain("successfully submitted");
    expect(events).toEqual([`settle:${ASHBY_SAVE_SETTLE_MS}`, "click", `settle:${ASHBY_RECLICK_SETTLE_MS}`, "click"]);
  });

  it("fails closed after the last allowed click still met the notice", async () => {
    const { page, clicks } = ashbyPage({ state: () => ({ ...quiet, busySeen: true }) });
    const error = await submitAndConfirm(page, FAST).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubmissionUnconfirmed);
    const unconfirmed = error as SubmissionUnconfirmed;
    expect(unconfirmed.message).toMatch(/still saving/);
    expect(unconfirmed.message).toContain("not marked submitted");
    expect(unconfirmed.evidence.detail).toBe(ASHBY_BUSY_DETAIL);
    expect(unconfirmed.evidence.outcome).toBe("unknown");
    expect(clicks()).toBe(ASHBY_MAX_SUBMIT_CLICKS);
  });

  it("holds Ashby's spam check as a challenge and never clicks again", async () => {
    const { page, clicks } = ashbyPage({
      state: (count) => (count > 0
        ? { ...quiet, spamCheck: true, failureText: "We couldn't submit your application Your application could not be verified. Try these steps …" }
        : quiet)
    });
    const error = await submitAndConfirm(page, FAST).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubmissionChallenged);
    expect(postSubmitEvidenceOf(error)?.outcome).toBe("challenged");
    expect(postSubmitEvidenceOf(error)?.challenge).toBe(ASHBY_SPAM_CHECK_DETAIL);
    expect(clicks()).toBe(1);
  });

  it("refuses on Ashby's failure container and never clicks again", async () => {
    const { page, clicks } = ashbyPage({
      state: (count) => (count > 0 ? { ...quiet, failureText: "We couldn't submit your application Something went wrong - sorry. We're looking into it!" } : quiet)
    });
    const error = await submitAndConfirm(page, FAST).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubmissionRefused);
    expect(postSubmitEvidenceOf(error)?.outcome).toBe("refused");
    expect(clicks()).toBe(1);
  });

  it("leaves other sites alone", async () => {
    const events: string[] = [];
    let clicked = false;
    const page: BrowserPage = {
      url: () => "https://job-boards.greenhouse.io/fixture/jobs/1",
      title: async () => "Apply",
      collectControls: async () => [],
      bodyText: async () => "Robotics Software Intern Submit Application",
      fillField: async () => {},
      chooseOption: async () => {},
      setChecked: async () => {},
      uploadFile: async () => {},
      clickSubmit: async () => {
        events.push("click");
        clicked = true;
      },
      screenshot: async () => {},
      close: async () => {},
      successText: async () => (clicked ? "Your application was successfully submitted." : ""),
      settleAshbySaves: async () => {
        events.push("settle");
      },
      ashbySubmitState: async () => {
        events.push("state");
        return quiet;
      },
      watchAshbyNetwork: async () => {
        events.push("watch");
      },
      ashbySubmitNetwork: async () => {
        events.push("network");
        return null;
      }
    };
    await expect(submitAndConfirm(page, FAST)).resolves.toContain("successfully submitted");
    expect(events).toEqual(["click"]);
  });

  it("reads Ashby's busy notice, spam check, and next step", () => {
    expect(isAshbyBusyNotice("We're updating your application (e.g. uploading files), please try again when they're finished.")).toBe(true);
    expect(isAshbyBusyNotice("We’re updating your application (e.g. uploading files), please try again when they’re finished.")).toBe(true);
    expect(isAshbyBusyNotice("We're updating your forms (e.g. uploading files), please try again when they're finished.")).toBe(true);
    expect(isAshbyBusyNotice("Please try again later.")).toBe(false);
    expect(isAshbyBusyNotice("We're updating our privacy policy")).toBe(false);
    expect(isAshbySpamCheck("Legitimate applications are occasionally flagged by mistake. Try these in order:")).toBe(true);
    expect(isAshbySpamCheck("There was a problem verifying this submission with CAPTCHA. Please try turning off your ad blocker or try again later.")).toBe(true);
    expect(isAshbySpamCheck("Something went wrong - sorry. We're looking into it!")).toBe(false);
    expect(nextAshbyStep({ ...quiet, spamCheck: true, failureText: "We couldn't submit your application" }, 1)).toBe("spam-check");
    expect(nextAshbyStep({ ...quiet, failureText: "We couldn't submit your application" }, 1)).toBe("refused");
    expect(nextAshbyStep({ ...quiet, busySeen: true }, 1)).toBe("click-again");
    expect(nextAshbyStep({ ...quiet, busySeen: true }, 2)).toBe("click-again");
    expect(nextAshbyStep({ ...quiet, busySeen: true }, ASHBY_MAX_SUBMIT_CLICKS)).toBe("wait");
    expect(nextAshbyStep({ ...quiet, busySeen: true, busyShown: true }, 1)).toBe("wait");
    expect(nextAshbyStep(quiet, 1)).toBe("wait");
    expect(isAshbyApplicationUrl("https://jobs.ashbyhq.com/fixture/1/application")).toBe(true);
    expect(isAshbyApplicationUrl("https://jobs.dover.com/job/1")).toBe(false);
    expect(isAshbyApplicationUrl("https://careers.example.com/jobs?ashby_jid=1")).toBe(false);
    expect(isAshbyApplicationUrl("not a url")).toBe(false);
  });
});

describe("known-answer gaps from the 2026-11-25 pass", () => {
  const phoneTypePlan = (phoneType: string, options: string[]) => planAutofill(recognizeForm("https://example.test/apply", "Apply", [
    control({ tag: "select", id: "phone-type", label: "Phone Device Type*", required: true, options })
  ]), { profile: { phoneType }, resolutions: new Map(), packageAnswers: [], variantId: null }).decisions[0]!;

  it("picks the one personal or home mobile option for a saved \"Mobile\" phone type (Workday tenants)", () => {
    const rows: Array<[string[], string]> = [
      [["Select One", "Home Mobile", "Home Phone", "Work Mobile", "Work Phone"], "Home Mobile"],
      [["Select One", "Corporate Mobile", "Fax", "Landline", "Personal Mobile", "TTY"], "Personal Mobile"],
      [["Select One", "Personal Landline", "Personal Mobile Phone"], "Personal Mobile Phone"],
      [["Select One", "Home", "Mobile - Personal", "Mobile - Work", "Work"], "Mobile - Personal"],
      [["Personal Mobile", "Corporate Mobile", "Work Mobile"], "Personal Mobile"]
    ];
    for (const [options, expected] of rows) {
      expect(phoneTypePlan("Mobile", options), options.join(", ")).toMatchObject({
        action: "choose", value: expected, basis: { kind: "profile", field: "phoneType" }, reason: "Contact details from your profile."
      });
    }
  });

  it("never picks a work mobile, and pauses a saved \"Home\" phone type with no exact option", () => {
    expect(phoneTypePlan("Home", ["Home Mobile", "Work Mobile"])).toMatchObject({ action: "pause" });
    expect(phoneTypePlan("Mobile", ["Work Mobile", "Corporate Mobile"])).toMatchObject({ action: "pause" });
    expect(phoneTypePlan("Mobile", ["Home Mobile", "Personal Mobile"])).toMatchObject({ action: "pause" });
  });

  it("types the saved start date in the format the field takes (synthetic date)", () => {
    const start: FieldResolution = { status: "RESOLVED", key: "available_start_date", scope: "global", display: "2027-06-01", value: "2027-06-01" };
    const form = recognizeForm("https://example.test/apply", "Apply", [
      control({ tag: "input", type: "text", id: "text", label: "What is your available start date?", required: true }),
      control({ tag: "input", type: "text", id: "dmy", label: "Start date (DD/MM/YYYY)", required: true }),
      control({ tag: "input", type: "date", id: "date", label: "Available start date", required: true }),
      control({ tag: "input", type: "workday-date", id: "formField-earliestStart", label: "What is the earliest date you can start employment?", required: true }),
      control({ tag: "input", type: "number", id: "number", label: "Start date", required: true })
    ]);
    expect(form.fields.map((field) => field.kind)).toEqual(["text", "text", "date", "date", "number"]);
    const plan = planAutofill(form, {
      profile: {},
      resolutions: new Map(form.fields.map((field) => [field.id, start])),
      packageAnswers: [],
      variantId: null
    });
    expect(plan.decisions.map((decision) => [decision.fieldId, decision.action, decision.value])).toEqual([
      ["text", "fill", "06/01/2027"],
      ["dmy", "fill", "01/06/2027"],
      ["date", "fill", "2027-06-01"],
      ["formField-earliestStart", "fill", "2027-06-01"],
      ["number", "pause", null]
    ]);
    expect(plan.decisions[0]!.basis).toEqual({ kind: "fact", key: "available_start_date", scope: "global" });
  });
});

describe("Ashby's submit on the network (Track 22)", () => {
  const FAST = { timeoutMs: 50, pollMs: 1 };
  const ENTRY = "0b1c2d3e-0000-4000-8000-0000000000d2_9a0b1c2d-0000-4000-8000-0000000000d1";
  const ENTRY_PATH = "9a0b1c2d-0000-4000-8000-0000000000d1";
  const MISSING = "Missing entry for required field: Visa Support";
  const PERSONAL = ["Jordan Rivera", "jordan.rivera@example.test", "+1 555 010 0199", "tok-5c2d", "fp-77aa", "UNIVERSAL_ENT"];
  const GRAPHQL = (op: string) => `https://jobs.ashbyhq.com/api/non-user-graphql?op=${op}`;
  const TOKEN_URL = "https://www.recaptcha.net/recaptcha/enterprise/reload?k=fixture-key";
  const submitBody = JSON.stringify({
    operationName: "ApiSubmitSingleApplicationFormAction",
    variables: {
      recaptchaToken: "UNIVERSAL_ENT===tok-5c2d",
      deviceFingerprint: "fp-77aa",
      answers: { name: "Jordan Rivera", email: "jordan.rivera@example.test", phone: "+1 555 010 0199" }
    }
  });
  const formRender = JSON.stringify({
    data: {
      submitApplicationFormAction: {
        applicationFormResult: {
          __typename: "FormRender",
          id: "render-1",
          fieldValues: { name: "Jordan Rivera", email: "jordan.rivera@example.test", phone: "+1 555 010 0199" },
          errorMessages: [MISSING],
          formErrors: [{ message: MISSING, fieldEntryId: ENTRY }]
        },
        messages: { blockMessageForCandidateHtml: null }
      }
    }
  });
  const submit = (partial: Partial<AshbySubmitCall> = {}): AshbySubmitCall => ({
    operation: "ApiSubmitSingleApplicationFormAction", status: 200, failed: false, clicks: 1, recaptchaToken: "present",
    resultType: null, success: false, errorCodes: [], errorMessages: [], formErrorMessages: [], fieldErrors: [], blockMessage: false,
    ...partial
  });
  const network = (submits: AshbySubmitCall[]): AshbySubmitNetwork => ({
    calls: submits.map((entry) => ({ operation: entry.operation, status: entry.status, failed: entry.failed, clicks: entry.clicks })),
    submits,
    recaptchaTokenRequests: submits.length,
    recaptchaTokenStatuses: submits.map(() => 200)
  });
  const rejected = network([submit({ errorCodes: [ASHBY_RECAPTCHA_REJECTED], errorMessages: ["Your application could not be verified."] })]);
  const accepted = network([submit({ resultType: "FormSubmitSuccess", success: true })]);
  const blocked = network([submit({ resultType: "FormSubmitSuccess", blockMessage: true })]);
  const fieldErrors = network([submit({ resultType: "FormRender", formErrorMessages: [MISSING], fieldErrors: [{ fieldEntryId: ENTRY, message: MISSING }] })]);

  it("records operation names, statuses, and the submit's answer, never a body", async () => {
    const recorder = createAshbyNetworkRecorder();
    const savePostData = vi.fn(() => JSON.stringify({ variables: { value: "Jordan Rivera" } }));
    const save = {};
    recorder.request(save, GRAPHQL("ApiSetFormValue"), savePostData);
    recorder.response(save, 200, async () => JSON.stringify({ data: { setFormValue: { value: "Jordan Rivera" } } }));
    recorder.noteClick();
    const token = {};
    recorder.request(token, TOKEN_URL, () => "token body");
    recorder.response(token, 200, async () => ")]}'");
    const submitRequest = {};
    recorder.request(submitRequest, GRAPHQL("ApiSubmitSingleApplicationFormAction"), () => submitBody);
    recorder.response(submitRequest, 200, async () => formRender);
    const snapshot = await recorder.snapshot();
    expect(savePostData).not.toHaveBeenCalled();
    expect(snapshot).toEqual({
      calls: [
        { operation: "ApiSetFormValue", status: 200, failed: false, clicks: 0 },
        { operation: "ApiSubmitSingleApplicationFormAction", status: 200, failed: false, clicks: 1 }
      ],
      submits: [{
        operation: "ApiSubmitSingleApplicationFormAction", status: 200, failed: false, clicks: 1, recaptchaToken: "present",
        resultType: "FormRender", success: false, errorCodes: [], errorMessages: [], formErrorMessages: [MISSING],
        fieldErrors: [{ fieldEntryId: ENTRY, message: MISSING }], blockMessage: false
      }],
      recaptchaTokenRequests: 1,
      recaptchaTokenStatuses: [200]
    });
    const text = JSON.stringify(snapshot);
    for (const secret of PERSONAL) expect(text).not.toContain(secret);
  });

  it("ignores other hosts, paths, and op names, marks failed requests, and caps its lists", async () => {
    const recorder = createAshbyNetworkRecorder();
    const postData = vi.fn(() => submitBody);
    recorder.request({}, "https://evil.example/api/non-user-graphql?op=ApiSubmitSingleApplicationFormAction", postData);
    recorder.request({}, "https://jobs.ashbyhq.com/api/graphql?op=ApiSubmitSingleApplicationFormAction", postData);
    recorder.request({}, "https://jobs.ashbyhq.com/api/non-user-graphql?op=<script>", postData);
    recorder.request({}, "https://www.recaptcha.net/recaptcha/enterprise/anchor?k=x", postData);
    expect(postData).not.toHaveBeenCalled();
    expect(await recorder.snapshot(0)).toEqual({ calls: [], submits: [], recaptchaTokenRequests: 0, recaptchaTokenStatuses: [] });
    recorder.noteClick();
    const lost = {};
    recorder.request(lost, GRAPHQL("ApiSubmitSingleApplicationFormAction"), () => submitBody);
    recorder.failed(lost);
    const failed = await recorder.snapshot(0);
    expect(failed.submits[0]).toMatchObject({ status: null, failed: true, clicks: 1 });
    expect(failed.calls[0]).toMatchObject({ status: null, failed: true });
    for (let index = 0; index < 45; index += 1) recorder.request({}, GRAPHQL("ApiSetFormValue"), () => null);
    for (let index = 0; index < 6; index += 1) recorder.request({}, GRAPHQL("ApiSubmitMultipleFormsAction"), () => null);
    for (let index = 0; index < 7; index += 1) recorder.request({}, TOKEN_URL, () => null);
    const capped = await recorder.snapshot(0);
    expect(capped.calls).toHaveLength(40);
    expect(capped.submits).toHaveLength(5);
    expect(capped.recaptchaTokenRequests).toBe(7);
    expect(capped.recaptchaTokenStatuses).toHaveLength(5);
    recorder.cancelClick();
    recorder.cancelClick();
    recorder.request({}, GRAPHQL("ApiSetFormValue"), () => null);
    expect(() => recorder.response({}, 200, () => { throw new Error("no body"); })).not.toThrow();
    expect(ashbyGraphqlOperation(GRAPHQL("ApiSetFormValue"))).toBe("ApiSetFormValue");
    expect(ashbyGraphqlOperation("https://fixture.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting")).toBe("ApiJobPosting");
    expect(ashbyGraphqlOperation("https://ashbyhq.com.evil.example/api/non-user-graphql?op=ApiJobPosting")).toBeNull();
    expect(ashbyGraphqlOperation("not a url")).toBeNull();
    expect(isRecaptchaTokenRequest(TOKEN_URL)).toBe(true);
    expect(isRecaptchaTokenRequest("https://www.google.com/recaptcha/api2/reload?k=x")).toBe(true);
    expect(isRecaptchaTokenRequest("https://recaptcha.evil.example/recaptcha/enterprise/reload")).toBe(false);
  });

  it("reads only the token's kind from a submit body", () => {
    expect(readAshbySubmitToken(submitBody)).toBe("present");
    expect(readAshbySubmitToken(JSON.stringify([{ variables: { recaptchaToken: "UNIVERSAL_ENT===recaptcha_dummy_token" } }]))).toBe("dummy");
    expect(readAshbySubmitToken(JSON.stringify({ variables: { recaptchaToken: "  " } }))).toBe("missing");
    expect(readAshbySubmitToken(JSON.stringify({ variables: {} }))).toBe("missing");
    expect(readAshbySubmitToken(null)).toBe("unknown");
    expect(readAshbySubmitToken("not json")).toBe("unknown");
  });

  it("reads Ashby's answers to a submit", () => {
    expect(readAshbySubmitResponse(200, JSON.stringify({ data: { submitApplicationFormAction: { applicationFormResult: { __typename: "FormSubmitSuccess" }, messages: { blockMessageForCandidateHtml: null } } } })))
      .toMatchObject({ resultType: "FormSubmitSuccess", success: true, blockMessage: false });
    expect(readAshbySubmitResponse(200, JSON.stringify({ data: null, errors: [{ message: "fixture", extensions: { ashbyErrorType: ASHBY_RECAPTCHA_REJECTED, message: "Your application could not be verified." } }] })))
      .toEqual({ resultType: null, success: false, errorCodes: [ASHBY_RECAPTCHA_REJECTED], errorMessages: ["Your application could not be verified."], formErrorMessages: [], fieldErrors: [], blockMessage: false });
    expect(readAshbySubmitResponse(200, JSON.stringify({ data: { submitSingleApplicationFormAction: { applicationFormResult: { __typename: "FormSubmitSuccess" }, messages: { blockMessageForCandidateHtml: "<p>You have reached the limit.</p>" } } } })))
      .toMatchObject({ resultType: "FormSubmitSuccess", success: false, blockMessage: true });
    expect(readAshbySubmitResponse(200, JSON.stringify({ data: { submitMultipleFormsAction: {
      applicationFormResult: { __typename: "FormSubmitSuccess" },
      surveyFormResults: [{ __typename: "FormRender", errorMessages: ["Survey answer missing"], formErrors: [{ message: "Survey answer missing", fieldEntryId: "survey-1" }] }]
    } } }))).toMatchObject({ resultType: "FormSubmitSuccess", success: false, formErrorMessages: ["Survey answer missing"], fieldErrors: [{ fieldEntryId: "survey-1", message: "Survey answer missing" }] });
    expect(readAshbySubmitResponse(500, JSON.stringify({ data: { submitApplicationFormAction: { applicationFormResult: { __typename: "FormSubmitSuccess" } } } }))).toMatchObject({ success: false });
    expect(readAshbySubmitResponse(500, JSON.stringify({ errors: [{ message: "Internal error" }] }))).toMatchObject({ errorMessages: ["Internal error"], errorCodes: [], success: false });
    const empty = { resultType: null, success: false, errorCodes: [], errorMessages: [], formErrorMessages: [], fieldErrors: [], blockMessage: false };
    expect(readAshbySubmitResponse(200, null)).toEqual(empty);
    expect(readAshbySubmitResponse(200, "not json")).toEqual(empty);
    expect(readAshbySubmitResponse(200, `{"data":"${"x".repeat(2_000_001)}"}`)).toEqual(empty);
    const many = readAshbySubmitResponse(200, JSON.stringify({ data: { submitApplicationFormAction: { applicationFormResult: {
      __typename: "FormRender",
      errorMessages: Array.from({ length: 15 }, (_, index) => `Error ${index} ${"y".repeat(300)}`),
      formErrors: [{ message: "x", fieldEntryId: "<bad id>" }]
    } } } }));
    expect(many.formErrorMessages).toHaveLength(10);
    expect(many.formErrorMessages.every((message) => message.length <= 200)).toBe(true);
    expect(many.fieldErrors).toEqual([{ fieldEntryId: null, message: "x" }]);
  });

  it("judges the record", () => {
    expect(ashbyNetworkVerdict(null)).toBe("none");
    expect(ashbyNetworkVerdict(network([]))).toBe("none");
    expect(ashbyNetworkVerdict(network([submit({ status: null })]))).toBe("none");
    expect(ashbyNetworkVerdict(rejected)).toBe("recaptcha-rejected");
    expect(ashbyNetworkVerdict(accepted)).toBe("accepted");
    expect(ashbyNetworkVerdict(blocked)).toBe("blocked");
    expect(ashbyNetworkVerdict(fieldErrors)).toBe("form-errors");
    expect(ashbyNetworkVerdict(network([submit({ status: 500, errorMessages: ["Internal error"] })]))).toBe("none");
    expect(ashbyNetworkInvalidFields(fieldErrors)).toEqual([{ ref: ENTRY_PATH, label: "", error: MISSING }]);
    expect(ashbyNetworkInvalidFields(network([submit({ resultType: "FormRender", formErrorMessages: ["Something is missing"] })]))).toEqual([{ ref: null, label: "", error: "Something is missing" }]);
    expect(ashbyNetworkInvalidFields(null)).toEqual([]);
    expect(ashbySubmitSentAfter(null, 1)).toBe(false);
    expect(ashbySubmitSentAfter(network([submit({ clicks: 1 })]), 1)).toBe(true);
    expect(ashbySubmitSentAfter(network([submit({ clicks: 1 })]), 2)).toBe(false);
  });

  function ashbyPage(options: {
    network: (clicks: number) => AshbySubmitNetwork | null;
    busyAtClick?: number;
    successAtClick?: number;
    diagnostics?: AshbySubmitDiagnostics | null;
  }) {
    const events: string[] = [];
    let clicks = 0;
    const page: BrowserPage = {
      url: () => "https://jobs.ashbyhq.com/fixture/1/application",
      title: async () => "Apply",
      collectControls: async () => [],
      bodyText: async () => "Robotics Software Intern Submit Application",
      fillField: async () => {},
      chooseOption: async () => {},
      setChecked: async () => {},
      uploadFile: async () => {},
      clickSubmit: async () => {
        events.push("click");
        clicks += 1;
      },
      screenshot: async () => {},
      close: async () => {},
      successText: async () => (options.successAtClick !== undefined && clicks >= options.successAtClick ? "Your application was successfully submitted." : ""),
      settleAshbySaves: async (ms) => {
        events.push(`settle:${ms}`);
      },
      ashbySubmitState: async () => ({
        busySeen: options.busyAtClick !== undefined && clicks === options.busyAtClick, busyShown: false, failureText: "", spamCheck: false
      }),
      watchAshbyNetwork: async () => {
        events.push("watch");
      },
      ashbySubmitNetwork: async () => options.network(clicks),
      ...(options.diagnostics !== undefined ? { ashbySubmitDiagnostics: async () => options.diagnostics ?? null } : {})
    };
    return { page, events, clicks: () => clicks };
  }

  it("starts the watch before the settle and the first click", async () => {
    const { page, events } = ashbyPage({ network: () => null, successAtClick: 1 });
    await expect(submitAndConfirm(page, FAST)).resolves.toContain("successfully submitted");
    expect(events.slice(0, 3)).toEqual(["watch", `settle:${ASHBY_SAVE_SETTLE_MS}`, "click"]);
  });

  it("holds Ashby's reCAPTCHA rejection as a challenge after one click", async () => {
    const { page, clicks } = ashbyPage({ network: (count) => (count > 0 ? rejected : network([])) });
    const error = await submitAndConfirm(page, FAST).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubmissionChallenged);
    const evidence = postSubmitEvidenceOf(error);
    expect(evidence?.outcome).toBe("challenged");
    expect(evidence?.challenge).toBe(ASHBY_SPAM_CHECK_DETAIL);
    expect(evidence?.ashbyNetwork).toEqual(rejected);
    expect(clicks()).toBe(1);
  });

  it("confirms Ashby's FormSubmitSuccess with no success container", async () => {
    const { page } = ashbyPage({ network: (count) => (count > 0 ? accepted : null) });
    await expect(submitAndConfirm(page, FAST)).resolves.toBe(ASHBY_ACCEPTED_CONFIRMATION);
  });

  it("pauses the fields Ashby's FormRender names", async () => {
    const { page, clicks } = ashbyPage({ network: (count) => (count > 0 ? fieldErrors : null) });
    const error = await submitAndConfirm(page, FAST).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubmissionNeedsInput);
    const needsInput = error as SubmissionNeedsInput;
    expect(needsInput.invalidFields).toEqual([{ ref: ENTRY_PATH, label: "", error: MISSING }]);
    expect(needsInput.message).toBe(ashbyFormErrorsMessage(1));
    expect(needsInput.evidence.outcome).toBe("field-errors");
    expect(clicks()).toBe(1);
  });

  it("refuses on Ashby's application-limit block message", async () => {
    const { page } = ashbyPage({ network: (count) => (count > 0 ? blocked : null) });
    const error = await submitAndConfirm(page, FAST).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubmissionRefused);
    expect((error as SubmissionRefused).message).toBe(ASHBY_BLOCKED_MESSAGE);
    expect(postSubmitEvidenceOf(error)?.outcome).toBe("refused");
  });

  it("never clicks again once a submit request went out after the click", async () => {
    const sentNoAnswer = network([submit({ status: null })]);
    const { page, clicks } = ashbyPage({ network: (count) => (count > 0 ? sentNoAnswer : null), busyAtClick: 1 });
    const error = await submitAndConfirm(page, FAST).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubmissionUnconfirmed);
    expect(clicks()).toBe(1);
  });

  it("fails closed when the record shows no verdict, keeping the record", async () => {
    const serverError = network([submit({ status: 500, errorMessages: ["Internal error"] })]);
    const { page } = ashbyPage({ network: (count) => (count > 0 ? serverError : null) });
    const error = await submitAndConfirm(page, FAST).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubmissionUnconfirmed);
    expect((error as SubmissionUnconfirmed).evidence.ashbyNetwork).toEqual(serverError);
  });

  // Nested here to reuse this block's Ashby page stub and network helpers.
  describe("Ashby submit diagnostics and the not-sent hold (Track 27)", () => {
    const APPLICATION = "https://jobs.ashbyhq.com/fixture/1/application";
    const onButton: AshbyClickCheck = { ashbySubmitButton: true, hitTarget: true, hitElement: null, tag: "button", typeAttribute: null, text: "Submit Application" };
    const diagnostics = (partial: Partial<AshbySubmitDiagnostics> = {}): AshbySubmitDiagnostics => ({
      clicks: [onButton], requests: [], requestsDropped: 0, console: [], consoleDropped: 0, visibleErrors: [], ...partial
    });
    const saves = (count: number, clicks = 1): AshbySubmitNetwork => ({
      calls: Array.from({ length: count }, () => ({ operation: "ApiSetFormValue", status: 200, failed: false, clicks })),
      submits: [],
      recaptchaTokenRequests: 0,
      recaptchaTokenStatuses: []
    });
    const group = (method: string, host: string, path: string) => ({ method, host, path, resourceType: "fetch", clicks: 1, count: 1, lastStatus: 200, failed: false });

    it("reduces request URLs to host and path, never a query, file name, email, or long number", () => {
      expect(diagnosticRequestTarget("https://Jobs.AshbyHQ.com/api/non-user-graphql?op=ApiSetFormValue#x")).toEqual({ host: "jobs.ashbyhq.com", path: "/api/non-user-graphql" });
      expect(diagnosticRequestTarget("https://files.example.test/uploads/123/Jordan-Rivera-resume.pdf")).toEqual({ host: "files.example.test", path: "/uploads/123/[file]" });
      expect(diagnosticRequestTarget("https://api.example.test/users/jordan%40example.test/profile")).toEqual({ host: "api.example.test", path: "/users/[redacted]/profile" });
      expect(diagnosticRequestTarget("https://api.example.test/track/order-12345678/a")).toEqual({ host: "api.example.test", path: "/track/order-[number]/a" });
      expect(diagnosticRequestTarget("data:text/plain,abc")).toEqual({ host: "data", path: "" });
      expect(diagnosticRequestTarget("not a url")).toBeNull();
    });

    it("sanitizes page texts of the page's own values, URL queries, emails, and long numbers", () => {
      const values = scrubValuesFrom(["Jordan Rivera", "jordan.rivera@example.test"]);
      const text = sanitizeDiagnosticText(
        `Submit failed for Jordan   Rivera <jordan.rivera@example.test> (rivera) at https://telemetry.fixture.invalid/report?token=secret-1 order 12345678 ${"z".repeat(300)}`,
        values
      );
      expect(text).toContain("telemetry.fixture.invalid/report");
      expect(text).toContain("[redacted]");
      expect(text).toContain("[number]");
      for (const secret of ["Jordan", "Rivera", "rivera", "jordan.rivera@example.test", "token=", "secret-1", "12345678"]) expect(text).not.toContain(secret);
      expect(text.length).toBeLessThanOrEqual(200);
      expect(sanitizeDiagnosticText("other.person@example.test called", [])).toBe("[email] called");
      expect(sanitizeDiagnosticText("Jordan Rivera", null)).toBe("");
      // A value's words ("https", "example") never break a URL and keep its query.
      const linked = sanitizeDiagnosticText("see https://report.example.test/r?token=secret-2", scrubValuesFrom(["https://www.linkedin.com/in/jordan-rivera", "jordan@example.test"]));
      expect(linked).toBe("see report.[redacted].[redacted]/r");
    });

    it("scrubs whole values and their words, dropping short ones", () => {
      expect(scrubValuesFrom(["  Jordan Rivera ", "ab", "NY", "jordan.rivera@example.test"])).toEqual([
        "Jordan Rivera", "jordan.rivera@example.test", "Jordan", "Rivera", "jordan", "rivera", "example", "test"
      ]);
      expect(scrubValuesFrom(Array.from({ length: 400 }, (_, index) => `value-${index}`))).toHaveLength(300);
    });

    it("records clicks, requests after the first click, console errors, and page errors; the snapshot keeps no value", () => {
      const recorder = createAshbyDiagnosticsRecorder();
      recorder.request({}, "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSetFormValue", "POST", "fetch");
      recorder.consoleMessage("log", "Jordan Rivera typed");
      recorder.consoleMessage("info", "info");
      recorder.consoleMessage("warning", "Slow save for Jordan Rivera");
      recorder.noteClick({ ...onButton, text: "Submit Application" });
      const token = {};
      recorder.request(token, "https://www.recaptcha.net/recaptcha/enterprise/reload?k=fixture-key", "post", "fetch");
      recorder.response(token, 200);
      const again = {};
      recorder.request(again, "https://www.recaptcha.net/recaptcha/enterprise/reload?k=other", "POST", "fetch");
      const lost = {};
      recorder.request(lost, "https://fingerprint.example.test/session", "GET", "xhr");
      recorder.failed(lost);
      recorder.consoleMessage("error", "Submit failed for jordan.rivera@example.test see https://x.fixture.invalid/r?token=t-1");
      recorder.pageError("TypeError: Rivera is not defined");
      const snapshot = recorder.snapshot(scrubValuesFrom(["Jordan Rivera", "jordan.rivera@example.test"]), ["Please check Jordan Rivera", "Please check Jordan Rivera", ""]);
      expect(snapshot.clicks).toEqual([onButton]);
      expect(snapshot.requests).toEqual([
        { method: "POST", host: "www.recaptcha.net", path: "/recaptcha/enterprise/reload", resourceType: "fetch", clicks: 1, count: 2, lastStatus: 200, failed: false },
        { method: "GET", host: "fingerprint.example.test", path: "/session", resourceType: "xhr", clicks: 1, count: 1, lastStatus: null, failed: true }
      ]);
      expect(snapshot.console.map((entry) => [entry.kind, entry.clicks])).toEqual([["warning", 0], ["error", 1], ["page-error", 1]]);
      expect(snapshot.console[1]!.text).toBe("Submit failed for [redacted] see x.fixture.invalid/r");
      expect(snapshot.visibleErrors).toEqual(["Please check [redacted]"]);
      const text = JSON.stringify(snapshot);
      for (const secret of ["Jordan Rivera", "jordan.rivera@example.test", "Rivera", "token="]) expect(text).not.toContain(secret);
      // Unreadable values: the texts are not kept at all.
      const blind = recorder.snapshot(null, ["Please check Jordan Rivera"]);
      expect(blind.console.every((entry) => entry.text === "")).toBe(true);
      expect(blind.visibleErrors).toEqual([]);
      expect(blind.clicks[0]!.text).toBe("");
    });

    it("drops a cancelled click's check, counts an unknown check as not proven, and caps its lists", () => {
      const recorder = createAshbyDiagnosticsRecorder();
      recorder.noteClick(onButton);
      recorder.cancelClick();
      expect(recorder.snapshot([], []).clicks).toEqual([]);
      recorder.request({}, "https://example.test/before", "GET", "fetch");
      expect(recorder.snapshot([], []).requests).toEqual([]);
      recorder.noteClick(null);
      expect(recorder.snapshot([], []).clicks).toEqual([{ ashbySubmitButton: false, hitTarget: false, hitElement: null, tag: "", typeAttribute: null, text: "" }]);
      for (let index = 0; index < 85; index += 1) recorder.request({}, `https://example.test/path-${index}`, "GET", "fetch");
      for (let index = 0; index < 25; index += 1) recorder.consoleMessage("error", `error ${index}`);
      const capped = recorder.snapshot([], []);
      expect(capped.requests).toHaveLength(80);
      expect(capped.requestsDropped).toBe(5);
      expect(capped.console).toHaveLength(20);
      expect(capped.consoleDropped).toBe(5);
      expect(() => recorder.response({}, 200)).not.toThrow();
      expect(() => recorder.failed({})).not.toThrow();
    });

    it("judges a click that sent nothing only when everything proves it", () => {
      expect(ashbyClickSentNothing(saves(2), diagnostics())).toBe(true);
      expect(ashbyClickSentNothing(saves(2, 0), diagnostics({ requests: [group("POST", "www.recaptcha.net", "/recaptcha/enterprise/reload"), group("POST", "jobs.ashbyhq.com", "/api/non-user-graphql")] }))).toBe(true);
      expect(ashbyClickSentNothing(null, diagnostics())).toBe(false);
      expect(ashbyClickSentNothing(saves(1), null)).toBe(false);
      expect(ashbyClickSentNothing(network([submit({ status: null })]), diagnostics())).toBe(false);
      expect(ashbyClickSentNothing(saves(40, 0), diagnostics())).toBe(false);
      expect(ashbyClickSentNothing({ ...saves(1), calls: [{ operation: "ApiJobPosting", status: 200, failed: false, clicks: 1 }] }, diagnostics())).toBe(false);
      expect(ashbyClickSentNothing(saves(1), diagnostics({ clicks: [] }))).toBe(false);
      expect(ashbyClickSentNothing(saves(1), diagnostics({ clicks: [{ ...onButton, ashbySubmitButton: false }] }))).toBe(false);
      expect(ashbyClickSentNothing(saves(1), diagnostics({ clicks: [{ ...onButton, hitTarget: false, hitElement: "div.overlay" }] }))).toBe(false);
      expect(ashbyClickSentNothing(saves(1), diagnostics({ requestsDropped: 1 }))).toBe(false);
      expect(ashbyClickSentNothing(saves(1), diagnostics({ requests: [group("POST", "jobs.ashbyhq.com", "/api/other")] }))).toBe(false);
    });

    it("holds a click on Ashby's button that sent nothing as a site safeguard", async () => {
      const seen = diagnostics({ requests: [group("POST", "www.recaptcha.net", "/recaptcha/enterprise/clr")] });
      const { page, clicks } = ashbyPage({ network: () => saves(1, 0), diagnostics: seen });
      const error = await submitAndConfirm(page, FAST).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(SubmissionChallenged);
      expect(error).toBeInstanceOf(SubmissionHeld);
      const message = (error as SubmissionChallenged).message;
      expect(message.startsWith(`Ashby did not send the application from the agent's browser; submit it yourself at ${APPLICATION}.`)).toBe(true);
      expect(message).toBe(ashbyNotSentMessage(APPLICATION));
      const evidence = postSubmitEvidenceOf(error);
      expect(evidence?.outcome).toBe("challenged");
      expect(evidence?.challenge).toBe(ASHBY_NOT_SENT_DETAIL);
      expect(evidence?.ashbyDiagnostics).toEqual(seen);
      expect(evidence?.ashbyNetwork).toEqual(saves(1, 0));
      expect(clicks()).toBe(1);
      expect(ashbyNotSentMessage("")).toContain("submit it yourself at the posting's application page.");
    });

    it("keeps today's unconfirmed outcome when the click is not proven or Ashby sent something", async () => {
      const outcome = async (options: Parameters<typeof ashbyPage>[0], busy = false) => {
        const { page } = ashbyPage(options);
        // Ashby's busy notice at every click: the existing busy outcome.
        if (busy) page.ashbySubmitState = async () => ({ busySeen: true, busyShown: false, failureText: "", spamCheck: false });
        return submitAndConfirm(page, FAST).then(() => null, (caught: unknown) => caught);
      };
      const offButton = await outcome({ network: () => saves(1, 0), diagnostics: diagnostics({ clicks: [{ ...onButton, ashbySubmitButton: false }] }) });
      expect(offButton).toBeInstanceOf(SubmissionUnconfirmed);
      expect((offButton as SubmissionUnconfirmed).evidence.ashbyDiagnostics?.clicks[0]?.ashbySubmitButton).toBe(false);
      const noDiagnostics = await outcome({ network: () => saves(1, 0) });
      expect(noDiagnostics).toBeInstanceOf(SubmissionUnconfirmed);
      expect((noDiagnostics as SubmissionUnconfirmed).evidence.ashbyDiagnostics).toBeUndefined();
      const busy = await outcome({ network: () => saves(1, 0), diagnostics: diagnostics() }, true);
      expect(busy).toBeInstanceOf(SubmissionUnconfirmed);
      expect((busy as SubmissionUnconfirmed).evidence.detail).toBe(ASHBY_BUSY_DETAIL);
      const sent = await outcome({ network: (count) => (count > 0 ? network([submit({ status: 500, errorMessages: ["Internal error"] })]) : null), diagnostics: diagnostics() });
      expect(sent).toBeInstanceOf(SubmissionUnconfirmed);
      expect(sent).not.toBeInstanceOf(SubmissionHeld);
    });
  });
});

describe("Read-back before the submit click (Track 25)", () => {
  const decision = (fieldId: string, action: FillDecision["action"], value: string | null): FillDecision =>
    ({ fieldId, action, value, basis: null, reason: "fixture", pause: null });
  const CONTROLS: RawControl[] = [
    control({ tag: "input", type: "radio", id: "club", label: "Which student club do you belong to?", options: ["Robotics", "Chess"] }),
    control({ tag: "select", id: "team", label: "Team", options: ["X", "Y"] }),
    control({ tag: "input", type: "text", id: "text", label: "Anything else?" })
  ];
  const form = recognizeForm("https://example.test/apply", "Apply", CONTROLS);
  const decisions = [decision("club", "choose", "Chess"), decision("team", "choose", "X"), decision("text", "fill", "y")];
  const shownWith = (value: string | undefined, drop = false) =>
    recognizeFields(CONTROLS.filter((entry) => !(drop && entry.id === "club")).map((entry) => (entry.id === "club" ? { ...entry, value } : entry)));
  const pageShowing = (read: () => Promise<ReturnType<typeof recognizeFields>>) => ({ readFields: read }) as unknown as BrowserPage;

  it("maps an Ashby field-entry id to its field path", () => {
    expect(ashbyFieldPath("73bb726a-b0f7-4639-9e72-3a04cd646a5e__systemfield_name")).toBe("_systemfield_name");
    expect(ashbyFieldPath("6a876f10-4249-48be-af03-e76978d9139a_901b3122-65bd-4c58-b252-24dc79e8b108")).toBe("901b3122-65bd-4c58-b252-24dc79e8b108");
    expect(ashbyFieldPath("survey-1")).toBe("survey-1");
    expect(ashbyFieldPath(null)).toBeNull();
  });

  it("names the value decisions whose field the form no longer shows", () => {
    const small = recognizeForm("https://example.test/apply", "Apply", [
      control({ tag: "input", type: "text", id: "a", label: "First answer" }),
      control({ tag: "input", type: "radio", id: "b", label: "Second answer", options: ["Yes", "No"] })
    ]);
    expect(absentDecisionFields(small, [
      decision("a", "fill", "x"), decision("c", "choose", "Yes"), decision("d", "upload", null),
      decision("e", "pause", null), decision("f", "skip", null), decision("g", "keep", null)
    ])).toEqual(["c", "d"]);
  });

  it("holds a changed form with one safeguard pause", () => {
    const held = formChangedPause(2);
    expect(held.pause).toMatchObject({ fieldId: FORM_CHANGED_FIELD, safeguard: true, status: "open", sensitive: false });
    expect(held.pause.question.startsWith("2 answer(s) the approval covered are no longer on the application form")).toBe(true);
    expect(held.decision.action).toBe("pause");
    expect(held.decision.pause?.safeguard).toBe(true);
  });

  it("passes a radio choice the page shows as made", async () => {
    expect(await choicesNotTaken(pageShowing(async () => shownWith("Chess")), form, decisions)).toEqual([]);
    expect(await choicesNotTaken(pageShowing(async () => shownWith("chess ")), form, decisions)).toEqual([]);
  });

  it("reports a radio choice the page does not show as made", async () => {
    const notTaken = [{ fieldId: "club", reason: "the page did not take the choice" }];
    expect(await choicesNotTaken(pageShowing(async () => shownWith(undefined)), form, decisions)).toEqual(notTaken);
    expect(await choicesNotTaken(pageShowing(async () => shownWith("Robotics")), form, decisions)).toEqual(notTaken);
  });

  it("reports a radio gone from the page or a read that fails", async () => {
    expect(await choicesNotTaken(pageShowing(async () => shownWith(undefined, true)), form, decisions)).toEqual([{ fieldId: "club", reason: "it is no longer on the page" }]);
    expect(await choicesNotTaken(pageShowing(async () => { throw new Error("detached"); }), form, decisions)).toEqual([{ fieldId: "club", reason: "the agent could not read the choice back" }]);
  });

  it("reads nothing back without readFields, and never reads a list back", async () => {
    expect(await choicesNotTaken({} as unknown as BrowserPage, form, decisions)).toEqual([]);
    const result = await choicesNotTaken(pageShowing(async () => shownWith(undefined)), form, decisions);
    expect(result.map((entry) => entry.fieldId)).toEqual(["club"]);
    expect(await choicesNotTaken(pageShowing(async () => shownWith(undefined)), form, [decision("team", "choose", "X")])).toEqual([]);
  });

  it("compares a clipped option by its prefix", async () => {
    const clipped = [decision("club", "choose", "A".repeat(199) + "…")];
    expect(await choicesNotTaken(pageShowing(async () => shownWith("A".repeat(250))), form, clipped)).toEqual([]);
  });
});

describe("unrecognized-site answers (Track 35)", () => {
  const fieldsOf = (...controls: RawControl[]) => recognizeFields(controls);
  const plan = (controls: RawControl[], resolutions: Array<[string, FieldResolution]> = [], profile: Record<string, string> = {}) => planAutofill(
    recognizeForm("https://careers.fixtureaero.example/careers/apply?pid=1001", "Apply", controls),
    { profile, resolutions: new Map(resolutions), packageAnswers: [], variantId: null }
  );
  const sexList = control({ tag: "select", id: "input-41", label: "Sex", options: ["Male", "Female", "I do not wish to self-identify"] });

  it("reads a \"Sex\" list as a self-identification question, never a sex-offender question", () => {
    const [sex, offender, orientation] = fieldsOf(
      sexList,
      control({ tag: "select", id: "offender", label: "Have you ever been registered as a sex offender?", options: ["Yes", "No"] }),
      control({ tag: "select", id: "orientation", label: "Sexual orientation", options: ["Prefer not to say"] })
    );
    expect(classifyFieldRole(sex!)).toBe("eeo");
    expect(classifyFieldRole(offender!)).not.toBe("eeo");
    expect(classifyFieldRole(orientation!)).toBe("eeo");
  });

  it("answers a \"Sex\" list only from the saved self-identification answer, else a sensitive pause", () => {
    const saved = plan([sexList], [["input-41", { status: "SELF_IDENTIFIED", key: "eeo_gender", option: "Female" }]]);
    expect(saved.decisions[0]).toMatchObject({ action: "choose", value: "Female", basis: { kind: "fact", key: "eeo_gender", scope: "global" } });
    expect(saved.pauses).toEqual([]);
    const unsaved = plan([sexList]);
    expect(unsaved.decisions[0]).toMatchObject({ action: "pause", value: null });
    expect(unsaved.pauses).toHaveLength(1);
    expect(unsaved.pauses[0]).toMatchObject({ fieldId: "input-41", sensitive: true });
  });

  it("never counts a job-alert email box as the application form, and leaves it empty", () => {
    const alert = control({ tag: "input", type: "text", id: "notifiedEmail", placeholder: "Please enter your email address" });
    const [alertField] = fieldsOf(alert);
    expect(alertField!.label).toBe("Please enter your email address");
    expect(hasApplicationFields([alertField!])).toBe(false);
    expect(hasApplicationFields(fieldsOf(alert, control({ tag: "input", type: "text", id: "first", label: "First name" })))).toBe(true);
    const planned = plan([{ ...alert, required: true }], [], { email: "applicant@example.test" });
    expect(planned.decisions[0]).toMatchObject({ fieldId: "notifiedEmail", action: "skip", value: null });
    expect(planned.pauses).toEqual([]);
  });

  it("skips a list's own required \"Search\" box but still pauses a real question that says search", () => {
    const planned = plan([
      control({ tag: "input", type: "text", id: "field-38", label: "Search", required: true }),
      control({ tag: "input", type: "text", id: "timeline", label: "What is your job search timeline?", required: true })
    ]);
    expect(planned.decisions.map((decision) => [decision.fieldId, decision.action])).toEqual([["field-38", "skip"], ["timeline", "pause"]]);
    expect(planned.pauses.map((pause) => pause.fieldId)).toEqual(["timeline"]);
  });

  it("types the option a searched list shows for a saved answer (pronoun prefix, standard Yes/No)", () => {
    const planned = plan([
      control({ tag: "select", widget: "autocomplete", id: "input-31", label: "Preferred Pronoun", options: ["He/Him/His", "She/Her/Hers", "They/Them/Theirs", "Prefer not to say"] }),
      control({ tag: "select", widget: "autocomplete", id: "input-55", label: "Do you currently hold an active security clearance?", options: ["Yes", "No"] })
    ], [
      ["input-31", { status: "RESOLVED", key: "pronouns", scope: "global", display: "they/them", value: "they/them" }],
      ["input-55", { status: "RESOLVED", key: "holds_security_clearance", scope: "global", display: "No", value: false }]
    ]);
    expect(planned.decisions.map((decision) => [decision.fieldId, decision.action, decision.value])).toEqual([
      ["input-31", "choose", "They/Them/Theirs"],
      ["input-55", "choose", "No"]
    ]);
    expect(planned.decisions[1]!.basis).toEqual({ kind: "fact", key: "holds_security_clearance", scope: "global" });
  });

  it("picks the profile country on a \"Country code picker\" list", () => {
    const planned = plan([
      control({ tag: "select", id: "Contact_Information_phone-country-code-picker", label: "Country code picker", value: "+1", options: ["United States (+1)", "Canada (+1)", "Mexico (+52)"] })
    ], [], { addressCountry: "United States" });
    expect(planned.decisions[0]).toMatchObject({ action: "choose", value: "United States (+1)", basis: { kind: "profile", field: "addressCountry" } });
  });
});

describe("live unrecognized forms (Track 37)", () => {
  const plan = (controls: RawControl[], resolutions: Array<[string, FieldResolution]> = [], profile: Record<string, string> = {}) => planAutofill(
    recognizeForm("https://careers.fixtureaero.example/careers/apply?pid=2002", "Apply", controls),
    { profile, resolutions: new Map(resolutions), packageAnswers: [], variantId: null }
  );
  const US_PICKER = "🇺🇸 (+1) United States of America";
  const PICKER_OPTIONS = [US_PICKER, "🇨🇦 (+1) Canada", "🇲🇽 (+52) Mexico"];

  it("takes the profile country on Phenom's \"Country Phone Code\" list (\"USA\", never a territory)", () => {
    const planned = plan([
      control({ tag: "select", id: "phoneWidget.countryPhoneCode", label: "Country Phone Code", required: true,
        options: ["Please Select", "Canada", "U.S. Virgin Islands", "United Kingdom", "United States Minor Outlying Islands", "USA", "Uruguay"] })
    ], [], { addressCountry: "United States" });
    expect(planned.decisions[0]).toMatchObject({ action: "choose", value: "USA", basis: { kind: "profile", field: "addressCountry" } });
    expect(planned.pauses).toEqual([]);
  });

  it("keeps a phone-country picker that already shows the profile's country, and chooses it when another shows", () => {
    const typeAhead = plan([
      control({ tag: "input", type: "text", widget: "autocomplete", id: "Contact_Information_phone-country-code-picker", label: "Country code picker", value: US_PICKER })
    ], [], { addressCountry: "United States" });
    expect(typeAhead.decisions[0]).toMatchObject({ action: "keep", value: US_PICKER });
    const other = plan([
      control({ tag: "select", id: "Contact_Information_phone-country-code-picker", label: "Country code picker", value: "🇨🇦 (+1) Canada", options: PICKER_OPTIONS })
    ], [], { addressCountry: "United States" });
    expect(other.decisions[0]).toMatchObject({ action: "choose", value: US_PICKER, basis: { kind: "profile", field: "addressCountry" } });
    const same = plan([
      control({ tag: "select", id: "Contact_Information_phone-country-code-picker", label: "Country code picker", value: US_PICKER, options: PICKER_OPTIONS })
    ], [], { addressCountry: "United States" });
    expect(same.decisions[0]).toMatchObject({ action: "keep", value: US_PICKER });
    expect(matchCountryOption("Canada", PICKER_OPTIONS)).toBe("🇨🇦 (+1) Canada");
  });

  it("picks the one single-set pronoun option the saved pronouns start, never a combined one", () => {
    const options = ["She/her/hers", "He/him/his", "They/them/theirs", "She/her/hers, they/them/theirs", "He/him/his, they/them/theirs", "Just use my name", "Enter my pronouns"];
    const pronouns = (display: string) => plan(
      [control({ tag: "select", id: "field-20", label: "Pronouns", options })],
      [["field-20", { status: "RESOLVED", key: "pronouns", scope: "global", display, value: display }]]
    ).decisions[0];
    expect(pronouns("she/her")).toMatchObject({ action: "choose", value: "She/her/hers", basis: { kind: "fact", key: "pronouns", scope: "global" } });
    expect(pronouns("he/him")).toMatchObject({ action: "choose", value: "He/him/his" });
    // Saved pronouns naming two sets are not narrowed to one: no option is guessed.
    expect(pronouns("she/her, they/them")).toMatchObject({ action: "pause", value: null });
  });

  describe("closing a site announcement over the form", () => {
    const welcome: AnnouncementCandidate = {
      index: 0,
      text: "× Welcome to the new Fixture Aero Careers Site! Our new careers experience is designed to make it easier to explore opportunities and apply at Fixture Aero.",
      formControls: 0,
      frames: 0,
      closes: [{ tag: "0-0", text: "×", ariaLabel: "Close welcome message", title: "" }]
    };

    it("closes a welcome message with its own close control", () => {
      expect(chooseAnnouncementClose([welcome])).toBe("0-0");
      expect(chooseAnnouncementClose([{ ...welcome, closes: [{ tag: "0-0", text: "×", ariaLabel: "", title: "" }] }])).toBe("0-0");
      expect(chooseAnnouncementClose([{ ...welcome, closes: [{ tag: "0-0", text: "Dismiss", ariaLabel: "", title: "" }] }])).toBe("0-0");
    });

    it("never closes a dialog with a form field, a frame, safeguard wording, or only an accept or continue control", () => {
      expect(chooseAnnouncementClose([{ ...welcome, formControls: 1 }])).toBeNull();
      expect(chooseAnnouncementClose([{ ...welcome, frames: 1 }])).toBeNull();
      for (const text of [
        "Sign in to continue",
        "We use cookies on this site",
        "Please complete the CAPTCHA",
        "Your session has expired",
        "Your application has been saved",
        "Verify your email address"
      ]) {
        expect(chooseAnnouncementClose([{ ...welcome, text }])).toBeNull();
      }
      expect(chooseAnnouncementClose([{ ...welcome, closes: [{ tag: "0-0", text: "Accept", ariaLabel: "", title: "" }, { tag: "0-1", text: "Continue", ariaLabel: "", title: "" }] }])).toBeNull();
      expect(chooseAnnouncementClose([])).toBeNull();
    });
  });
});

describe("high-school and every-school questions (the candidate's rule, 2026-11-26)", () => {
  type Inputs = Parameters<typeof planAutofill>[1];
  const college: EducationRow = {
    key: "college", school: "Example State University", level: "bachelor", degree: "B.A. Computer Science",
    fieldOfStudy: "Computer Science", gpa: null, startYear: 2025, endYear: 2028
  };
  const highSchool: EducationRow = {
    key: "high_school", school: "Northwind High School", level: "high_school", degree: null, fieldOfStudy: null, gpa: null, startYear: 2021, endYear: 2025
  };
  const schools = { rows: [college, highSchool], highSchoolPlace: { city: "Springfield", region: "Oregon", postalCode: "97477" } };
  const graduation = { date: "2028-05-15", basis: { kind: "fact" as const, key: "graduation_date", scope: "global" } };
  const collegeDate = { status: "RESOLVED", key: "graduation_date", scope: "global", display: "2028-05-15", value: "2028-05-15" } as const;
  const plan = (controls: RawControl[], extra: Partial<Inputs> = {}) =>
    planAutofill(recognizeForm("https://job-boards.greenhouse.io/fixture/jobs/3", "Apply", controls), {
      profile: { addressCity: "Fixture City", addressRegion: "Washington", addressPostalCode: "98001", gpa: "3.8" },
      resolutions: new Map(), packageAnswers: [], variantId: null,
      education: { school: "Example State University", degree: "B.A. Computer Science", startMonth: "2025-08", graduation },
      schools, ...extra
    });
  const decision = (result: ReturnType<typeof planAutofill>, id: string) => result.decisions.find((entry) => entry.fieldId === id)!;
  const text = (id: string, label: string, required = label.endsWith("*")) => control({ tag: "input", type: "text", id, label, required });

  it("fills a High school question with the saved high school", () => {
    const result = plan([text("hs", "High school*")]);
    expect(decision(result, "hs")).toMatchObject({ action: "fill", value: "Northwind High School", basis: { kind: "profile", field: "highSchoolName" } });
    expect(result.pauses).toEqual([]);
  });

  it("answers a high-school graduation year from the high school, never the college's graduation date", () => {
    const year = plan([text("hs_year", "High school graduation year*")], { resolutions: new Map([["hs_year", collegeDate]]) });
    expect(decision(year, "hs_year")).toMatchObject({ action: "fill", value: "2025", basis: { kind: "profile", field: "highSchoolEndYear" } });
    const date = plan([text("hs_date", "High school graduation date*")], { resolutions: new Map([["hs_date", collegeDate]]) });
    expect(decision(date, "hs_date").action).toBe("pause");
    expect(decision(date, "hs_date").value).toBeNull();
    const optional = plan([text("hs_date", "High school graduation date")], { resolutions: new Map([["hs_date", collegeDate]]) });
    expect(decision(optional, "hs_date")).toMatchObject({ action: "skip", value: null });
  });

  it("answers the high school's city, state, ZIP code, and location from the saved place, never the mailing address", () => {
    const result = plan([
      text("hs_city", "High school city"),
      control({ tag: "select", id: "hs_state", label: "High school state", options: ["Oregon", "Washington"] }),
      text("hs_zip", "High school ZIP code"),
      text("hs_location", "High school location")
    ]);
    expect(decision(result, "hs_city")).toMatchObject({ action: "fill", value: "Springfield", basis: { kind: "profile", field: "highSchoolCity" } });
    expect(decision(result, "hs_state")).toMatchObject({ action: "choose", value: "Oregon", basis: { kind: "profile", field: "highSchoolRegion" } });
    expect(decision(result, "hs_zip")).toMatchObject({ action: "fill", value: "97477", basis: { kind: "profile", field: "highSchoolPostalCode" } });
    expect(decision(result, "hs_location")).toMatchObject({ action: "fill", value: "Springfield, Oregon", basis: { kind: "profile", field: "highSchoolPlace" } });
  });

  it("chooses the one fitting high-school option, and pauses when none fits", () => {
    const list = (options: string[]) => control({ tag: "select", id: "hs_list", label: "Which high school did you attend?*", required: true, options });
    expect(decision(plan([list(["Northwind High School", "Southwind High School"])]), "hs_list"))
      .toMatchObject({ action: "choose", value: "Northwind High School" });
    const none = plan([list(["Southwind High School"])]);
    expect(decision(none, "hs_list").action).toBe("pause");
    expect(none.pauses).toHaveLength(1);
  });

  it("pauses a required high-school question and skips an optional one when nothing is saved", () => {
    // No schools input at all.
    const required = planAutofill(recognizeForm("https://job-boards.greenhouse.io/fixture/jobs/3", "Apply", [text("hs", "High school*")]), {
      profile: {}, resolutions: new Map(), packageAnswers: [], variantId: null
    });
    expect(decision(required, "hs").action).toBe("pause");
    const optional = planAutofill(recognizeForm("https://job-boards.greenhouse.io/fixture/jobs/3", "Apply", [text("hs", "High school")]), {
      profile: {}, resolutions: new Map(), packageAnswers: [], variantId: null
    });
    expect(decision(optional, "hs")).toMatchObject({ action: "skip", value: null });
  });

  it("leaves an optional high-school GPA empty", () => {
    expect(decision(plan([text("hs_gpa", "High school GPA")]), "hs_gpa")).toMatchObject({ action: "skip", value: null });
  });

  it("lists every school attended, the college first, only when both are saved", () => {
    const area = control({ tag: "textarea", id: "all", label: "Please list all schools you have attended*", required: true });
    expect(decision(plan([area]), "all")).toMatchObject({
      action: "fill",
      value: "Example State University, B.A. Computer Science, 2025-2028\nNorthwind High School, Springfield, Oregon, 2021-2025",
      basis: { kind: "profile", field: "education" }
    });
    expect(decision(plan([text("all", "Please list all schools you have attended*")]), "all")).toMatchObject({
      action: "fill",
      value: "Example State University, B.A. Computer Science, 2025-2028; Northwind High School, Springfield, Oregon, 2021-2025"
    });
    const collegeOnly = plan([area], { schools: { rows: [college] } });
    expect(decision(collegeOnly, "all").action).toBe("pause");
  });
  it("keeps the high-school rule and the field-of-study and location lists apart on one form", () => {
    const result = plan([
      control({ tag: "select", id: "fos", label: "Field of study*", required: true, options: ["Select...", "Engineering (Non-Computer Science)", "Engineering – Computer Science & Technology", "Other"] }),
      control({ tag: "select", id: "where", label: "Where are you currently located?*", required: true, options: ["Canada", "United States of America"] }),
      control({ tag: "input", type: "text", id: "hs", label: "High school*", required: true }),
      control({ tag: "input", type: "text", id: "hsloc", label: "High school location" })
    ], { profile: { fieldOfStudy: "Computer Science", addressCity: "Springfield", addressRegion: "Illinois", addressCountry: "United States of America" } });
    expect(decision(result, "fos")).toMatchObject({ action: "choose", value: "Engineering – Computer Science & Technology", basis: { kind: "profile", field: "fieldOfStudy" } });
    expect(decision(result, "where")).toMatchObject({ action: "choose", value: "United States of America", basis: { kind: "profile", field: "addressCountry" } });
    expect(decision(result, "hs")).toMatchObject({ action: "fill", value: "Northwind High School", basis: { kind: "profile", field: "highSchoolName" } });
    expect(decision(result, "hsloc")).toMatchObject({ action: "fill", value: "Springfield, Oregon" });
  });
});

describe("known answers on Veeva's Lever and OpenSesame's Greenhouse forms (Track 43, synthetic profile values)", () => {
  type Inputs = Parameters<typeof planAutofill>[1];
  const plan = (controls: RawControl[], extra: Partial<Inputs> = {}) =>
    planAutofill(recognizeForm("https://jobs.lever.co/fixture/00000000-0000-0000-0000-000000000000/apply", "Apply", controls), {
      profile: {}, resolutions: new Map(), packageAnswers: [], variantId: null, ...extra
    });
  const actions = (result: ReturnType<typeof planAutofill>) =>
    Object.fromEntries(result.decisions.map((decision) => [decision.fieldId, [decision.action, decision.value]]));
  const GPA_RANGES = ["3.7 - 4.0", "3.3 - 3.69", "3.0 - 3.29", "2.7 - 2.99", "< 2.7"];
  const gpaRadio = (label = "Please specify the overall average grade (GPA) for your last/current degree:*") =>
    control({ tag: "input", type: "radio", id: "gpa", label, required: true, options: GPA_RANGES });

  it("answers a sentence-style GPA label, reading a GPA between two ranges to the options' own decimals", () => {
    expect(actions(plan([gpaRadio()], { profile: { gpa: "3.295" } }))).toEqual({ gpa: ["choose", "3.0 - 3.29"] });
    expect(actions(plan([gpaRadio()], { profile: { gpa: "2.995" } }))).toEqual({ gpa: ["choose", "2.7 - 2.99"] });
    expect(actions(plan([gpaRadio()], { profile: { gpa: "3.5" } }))).toEqual({ gpa: ["choose", "3.3 - 3.69"] });
    expect(plan([gpaRadio()], { profile: { gpa: "3.295" } }).decisions[0]!.basis).toEqual({ kind: "profile", field: "gpa" });
    expect(actions(plan([gpaRadio("Please specify your major GPA:*")], { profile: { gpa: "3.5" } }))).toEqual({ gpa: ["pause", null] });
    const box = control({ tag: "input", type: "text", id: "gpa_text", label: "Please enter your GPA*", required: true });
    expect(actions(plan([box], { profile: { gpa: "3.295" } }))).toEqual({ gpa_text: ["fill", "3.29"] });
  });

  it("chooses the field-of-study category naming the profile's field, never the negated one", () => {
    const study = control({
      tag: "select", id: "study", label: "Please select your field of study:*", required: true,
      options: [
        "Select...", "Business & Management", "Engineering (Non-Computer Science)", "Engineering – Computer Science & Technology",
        "Physical Sciences", "Mathematics & Statistics", "Other"
      ]
    });
    const chosen = plan([study], { profile: { fieldOfStudy: "Computer Science" } });
    expect(actions(chosen)).toEqual({ study: ["choose", "Engineering – Computer Science & Technology"] });
    expect(chosen.decisions[0]!.basis).toEqual({ kind: "profile", field: "fieldOfStudy" });
    expect(actions(plan([study], { profile: { fieldOfStudy: "Physics" } }))).toEqual({ study: ["pause", null] });
  });

  it("chooses the graduation term holding the resolved graduation date", () => {
    const terms = control({
      tag: "input", type: "radio", id: "term", label: "What is Your Expected Graduation Date?*", required: true,
      options: ["December 2028 or later", "Spring 2028", "December 2027", "Spring 2027", "December 2026", "Spring 2026 or earlier"]
    });
    const resolution = { status: "RESOLVED", key: "graduation_date", scope: "global", display: "2027-05-15", value: "2027-05-15" } as const;
    const result = plan([terms], { resolutions: new Map([["term", resolution]]) });
    expect(actions(result)).toEqual({ term: ["choose", "Spring 2027"] });
    expect(result.decisions[0]!.basis).toEqual({ kind: "fact", key: "graduation_date", scope: "global" });
  });

  it("answers a country list for \"Where are you currently located?\" from the profile address's country only", () => {
    const where = control({
      tag: "select", id: "where", label: "Where are you currently located?*", required: true, options: ["United States of America", "Other (International)"]
    });
    const place = { addressCity: "Springfield", addressRegion: "IL" };
    const chosen = plan([where], { profile: { ...place, addressCountry: "United States" } });
    expect(actions(chosen)).toEqual({ where: ["choose", "United States of America"] });
    expect(chosen.decisions[0]!.basis).toEqual({ kind: "profile", field: "addressCountry" });
    expect(actions(plan([where], { profile: { ...place, addressCountry: "Canada" } }))).toEqual({ where: ["pause", null] });
    expect(actions(plan([where], { profile: place }))).toEqual({ where: ["pause", null] });
  });

  it("chooses Yes for a resolved unrestricted right to work", () => {
    const radio = control({ tag: "input", type: "radio", id: "unrestricted", label: "Do you have the unrestricted right to work in the United States?*", required: true, options: ["Yes", "No"] });
    const resolution = { status: "RESOLVED", key: "unrestricted_us_work_authorization", scope: "global", display: "Yes", value: true } as const;
    expect(actions(plan([radio], { resolutions: new Map([["unrestricted", resolution]]) }))).toEqual({ unrestricted: ["choose", "Yes"] });
  });

  it("picks the one Yes/No sentence a saved work authorization or relocation names, season pairs, and the profile degree's range option (Track 57)", () => {
    // Fictional option lists shaped like the held Greenhouse, Workday, and Ashby runs' (2026-11-26).
    const authorizedOptions = [
      "Yes, I am currently legally authorized to work in the country where the job is located.",
      "No, I am not currently legally authorized to work in the country where the job is located."
    ];
    const authorized = { status: "RESOLVED", key: "authorized_to_work", scope: "country:US", display: "Yes", value: true } as const;
    const authorization = (options: string[]) => control({
      tag: "select", id: "auth", label: "Are you legally authorized to work in the country where the job is located?*", required: true, options
    });
    const chosen = plan([authorization(authorizedOptions)], { resolutions: new Map([["auth", authorized]]) });
    expect(actions(chosen)).toEqual({ auth: ["choose", authorizedOptions[0]] });
    expect(chosen.decisions[0]!.basis).toEqual({ kind: "fact", key: "authorized_to_work", scope: "country:US" });
    const twoYes = ["Select One", "Yes, on an unrestricted and indefinite basis", "Yes, with restrictions and/or for a fixed time period", "No"];
    expect(actions(plan([authorization(twoYes)], { resolutions: new Map([["auth", authorized]]) }))).toEqual({ auth: ["pause", null] });

    const relocate = control({
      tag: "select", id: "relocate", label: "Are you willing to relocate?", required: true,
      options: ["Select One", "Yes, I am willing to relocate.", "No, I am not willing to relocate.", "I am open to relocation."]
    });
    const willing = { status: "RESOLVED", key: "willing_to_relocate", scope: "country:US", display: "Yes", value: true } as const;
    expect(actions(plan([relocate], { resolutions: new Map([["relocate", willing]]) }))).toEqual({ relocate: ["choose", "Yes, I am willing to relocate."] });

    const graduation = { status: "RESOLVED", key: "graduation_date", scope: "global", display: "2028-05-15", value: "2028-05-15" } as const;
    const pairs = control({
      tag: "input", type: "radio", id: "term", label: "When is your expected graduation date (month and year)?*", required: true,
      options: ["Spring/Summer 2027", "Fall/Winter 2027", "Spring/Summer 2028", "Fall/Winter 2028", "Spring/Summer 2029", "Winter 2029 or later"]
    });
    expect(actions(plan([pairs], { resolutions: new Map([["term", graduation]]) }))).toEqual({ term: ["choose", "Spring/Summer 2028"] });

    const ranges = control({
      tag: "select", id: "level", label: "Confirm the degree you are pursuing and your expected graduation.*", required: true,
      options: [
        "Bachelors - Senior (December 2026 - June 2027)", "Bachelors - Junior (December 2027 - June 2028)",
        "Bachelors - Sophomore (December 2028 - June 2029)", "Masters - 1st Year (December 2027 - June 2028)", "Doctorate Student",
        "I am not currently enrolled as a university or college student."
      ]
    });
    const bachelor = plan([ranges], { resolutions: new Map([["level", graduation]]), education: { degree: "B.S. Computer Science" } });
    expect(actions(bachelor)).toEqual({ level: ["choose", "Bachelors - Junior (December 2027 - June 2028)"] });
    expect(bachelor.decisions[0]!.basis).toEqual({ kind: "fact", key: "graduation_date", scope: "global" });
    expect(actions(plan([ranges], { resolutions: new Map([["level", graduation]]), education: { degree: "M.S. Computer Science" } }))).toEqual({ level: ["pause", null] });
  });

  it("picks the one work-authorization option a saved U.S. citizenship makes true, and the relocating Yes among several (Track 62)", () => {
    // Fictional option lists shaped like the held Workday and Greenhouse runs' (2026-11-26).
    const ELIGIBLE = [
      "Select One",
      "Yes, I am eligible for employment in the US (includes US Citizenship & Permanent Residency).",
      "Yes, I am legally eligible to work in the US but I require Fixture Dynamics to sponsor or support a work visa now OR in the future.",
      "No, I am not eligible for US employment."
    ];
    const UNRESTRICTED = [
      "Select One",
      "Yes, on an unrestricted and indefinite basis (regardless of extensions/renewals)",
      "Yes, with restrictions and/or for a fixed time period (requiring extensions/renewals for right-to-work maintenance)",
      "No"
    ];
    const STATUSES = [
      "I am authorized to work in the United States for any employer",
      "I am authorized to work in the United States for my present employer",
      "I require sponsorship to work in the United States",
      "I am not authorized to work in the United States",
      "My status to work in the United States is unknown",
      "If Other, please explain:"
    ];
    const TWO = ["Yes, I am a U.S. citizen", "I am authorized to work for any employer", "No"];
    const CITIZEN = { kind: "fact", key: "us_citizen", scope: "global" };
    const citizen = { status: "RESOLVED", key: "authorized_to_work", scope: "country:US", display: "Yes", value: true, usCitizen: true } as const;
    const plain = { status: "RESOLVED", key: "authorized_to_work", scope: "country:US", display: "Yes", value: true } as const;
    const select = (options: string[]) => control({ tag: "select", id: "auth", label: "Are you legally eligible for employment in the United States?*", required: true, options });
    const radio = (options: string[]) => control({ tag: "input", type: "radio", id: "auth", label: "Are you legally authorized to work in the United States?*", required: true, options });
    const run = (field: RawControl, resolution: FieldResolution) => plan([field], { resolutions: new Map([["auth", resolution]]) });

    const granite = run(select(ELIGIBLE), citizen);
    expect(actions(granite)).toEqual({ auth: ["choose", ELIGIBLE[1]] });
    expect(granite.decisions[0]!.basis).toEqual(CITIZEN);
    expect(actions(run(select(UNRESTRICTED), citizen))).toEqual({ auth: ["choose", UNRESTRICTED[1]] });
    const statuses = run(radio(STATUSES), citizen);
    expect(actions(statuses)).toEqual({ auth: ["choose", STATUSES[0]] });
    expect(statuses.decisions[0]!.basis).toEqual(CITIZEN);
    expect(actions(run(select(TWO), citizen))).toEqual({ auth: ["pause", null] });
    expect(actions(run(select(["Select One", "Yes, I do not require sponsorship now but will in the future", "No"]), citizen))).toEqual({ auth: ["pause", null] });
    for (const options of [ELIGIBLE, UNRESTRICTED, STATUSES]) {
      expect(actions(run(select(options), plain))).toEqual({ auth: ["pause", null] });
    }

    const searched = run(control({ tag: "select", widget: "autocomplete", id: "auth", label: "Are you legally eligible for employment in the United States?", required: true, options: ELIGIBLE }), citizen);
    expect(actions(searched)).toEqual({ auth: ["choose", ELIGIBLE[1]] });
    expect(searched.decisions[0]!.basis).toEqual(CITIZEN);

    const unrestricted = { status: "RESOLVED", key: "unrestricted_us_work_authorization", scope: "global", display: "Yes", value: true, usCitizen: true } as const;
    expect(actions(run(select(UNRESTRICTED), unrestricted))).toEqual({ auth: ["choose", UNRESTRICTED[1]] });

    const relocate = control({
      tag: "select", id: "relocate", label: "If this position requires being in the office, are you within a 60-minute commute or willing to relocate?", required: true,
      options: ["Select One", "Yes: I live nearby or the role is remote", "Yes: I am willing to relocate", "No"]
    });
    const willing = { status: "RESOLVED", key: "willing_to_relocate", scope: "country:US", display: "Yes", value: true } as const;
    const moved = plan([relocate], { resolutions: new Map([["relocate", willing]]) });
    expect(actions(moved)).toEqual({ relocate: ["choose", "Yes: I am willing to relocate"] });
    expect(moved.decisions[0]!.basis).toEqual({ kind: "fact", key: "willing_to_relocate", scope: "country:US" });
  });
});

describe("held-question wordings and option shapes (Track 79, fictional profile and values)", () => {
  type Inputs = Parameters<typeof planAutofill>[1];
  const TODAY = "2026-11-27";
  const plan = (controls: RawControl[], extra: Partial<Inputs> = {}) =>
    planAutofill(recognizeForm("https://job-boards.greenhouse.io/fixture/jobs/79", "Apply", controls), {
      profile: {}, resolutions: new Map(), packageAnswers: [], variantId: null,
      standing: { acceptDataConsent: false, signAttestations: false, today: TODAY }, ...extra
    });
  const only = (result: ReturnType<typeof planAutofill>) => result.decisions[0]!;
  const resolved = (key: string, value: boolean | string, display = typeof value === "boolean" ? (value ? "Yes" : "No") : value) =>
    ({ status: "RESOLVED", key, scope: "global", display, value }) as const;
  const text = (id: string, label: string) => control({ tag: "input", type: "text", id, label, required: true });
  const area = (id: string, label: string) => control({ tag: "textarea", id, label, required: true });
  const select = (id: string, label: string, options: string[]) => control({ tag: "select", id, label, required: true, options });
  const group = (id: string, label: string, options: string[]) => control({ tag: "input", type: "checkbox", widget: "checkbox-group", id, label, required: true, options });
  const profile = {
    fullName: "Avery Example", linkedinUrl: "https://www.linkedin.com/in/avery-example", githubUrl: "https://github.com/avery-example",
    portfolioUrl: "https://avery.example", addressLine1: "1 Fixture Way", addressCity: "Springfield", addressRegion: "Illinois", fieldOfStudy: "Computer Science"
  };

  it.each<[string, RawControl, string]>([
    ["LinkedIn Profile URL:", text("li", "LinkedIn Profile URL:"), profile.linkedinUrl],
    ["LinkedIn Profle", text("li", "LinkedIn Profle"), profile.linkedinUrl],
    ["LinkedIn Profile (textarea)", area("li", "LinkedIn Profile"), profile.linkedinUrl],
    ["Github Link", text("gh", "Github Link"), profile.githubUrl],
    ["Please link your Github profile", text("gh", "Please link your Github profile"), profile.githubUrl],
    ["GitHub or personal website", area("gh", "GitHub or personal website"), profile.githubUrl],
    ["Portfolio", text("pf", "Portfolio"), profile.portfolioUrl],
    ["First & Last Name", text("nm", "First & Last Name"), profile.fullName],
    ["What is your Legal Name?", text("nm", "What is your Legal Name?"), profile.fullName],
    ["Home Address Line 1", text("ad", "Home Address Line 1"), profile.addressLine1],
    ["Major or Field of Study", text("fs", "Major or Field of Study"), profile.fieldOfStudy],
    ["Major(s)", text("fs", "Major(s)"), profile.fieldOfStudy],
    ["Location - City and State of Residence", text("lc", "Location - City and State of Residence"), "Springfield, Illinois"]
  ])("fills %s from the profile", (_label, field, value) => {
    expect(only(plan([field], { profile }))).toMatchObject({ action: "fill", value });
  });

  it("never fills an Address text area with the first address line", () => {
    expect(only(plan([area("ad", "Address")], { profile })).action).toBe("pause");
  });

  it("reads new GPA labels and option shapes from the profile GPA, never rounding up", () => {
    const gpa = { gpa: "3.684" };
    for (const label of ["Whats your current GPA?", "GPA (undergraduate)", "What is your most current GPA? (If recently graduated, provide your GPA at graduation)", "What’s your cumulative GPA?"]) {
      expect(only(plan([text("g", label)], { profile: gpa }))).toMatchObject({ action: "fill", value: "3.68", basis: { kind: "profile", field: "gpa" } });
    }
    const decimals = select("g", "GPA", ["4.0", "3.9", "3.8", "3.7", "3.6", "3.5", "3.4"]);
    expect(only(plan([decimals], { profile: gpa }))).toMatchObject({ action: "choose", value: "3.6" });
    const outOf = select("g", "GPA", ["3.8 out of 4.0", "3.7 out of 4.0", "3.6 out of 4.0", "3.5 out of 4.0"]);
    expect(only(plan([outOf], { profile: gpa }))).toMatchObject({ action: "choose", value: "3.6 out of 4.0" });
    const thresholds = select("g", "GPA", [">4.0", "4.0+", "3.7+", "3.5+", "3.2+", "3.0+", "<3.0"]);
    expect(only(plan([thresholds], { profile: gpa }))).toMatchObject({ action: "choose", value: "3.5+" });
    const mixed = select("g", "GPA", ["3.5+", "3.0 - 4.0"]);
    expect(only(plan([mixed], { profile: gpa })).action).toBe("pause");
    expect(only(plan([text("g", "Major GPA")], { profile: gpa })).action).not.toBe("fill");
  });

  it("answers a graduation term checkbox group and a graduation comparison", () => {
    const date = resolved("graduation_date", "2030-05-15");
    const terms = group("t", "What is your expected graduation date for your current degree program?", ["Spring 2029", "Winter 2029", "Spring 2030", "Fall 2030"]);
    expect(only(plan([terms], { resolutions: new Map([["t", date]]) }))).toMatchObject({ action: "choose", value: "Spring 2030", basis: { kind: "fact", key: "graduation_date" } });
    const before = select("b", "Will you be graduating before September 2030?", ["Yes", "No"]);
    expect(only(plan([before], { resolutions: new Map([["b", date]]) }))).toMatchObject({ action: "choose", value: "Yes" });
    const closest = select("c", "When do you expect to graduate? (Select the closest date.)", ["December 2029", "June 2030", "December 2030"]);
    expect(only(plan([closest], { resolutions: new Map([["c", date]]) }))).toMatchObject({ action: "choose", value: "June 2030" });
    const spans = select("s", "What is your ancitipated graduation season?", ["Spring 2030 (January - May)", "Summer 2030 (June or later)", "Later than Summer 2030"]);
    expect(only(plan([spans], { resolutions: new Map([["s", date]]) }))).toMatchObject({ action: "choose", value: "Spring 2030 (January - May)" });
  });

  it("types the graduation date as month and year when the label asks for it", () => {
    const date = resolved("graduation_date", "2030-05-15");
    expect(only(plan([text("m", "When are you expected to graduate? (MM/YYYY)")], { resolutions: new Map([["m", date]]) }))).toMatchObject({ action: "fill", value: "05/2030" });
    expect(only(plan([text("m", "What is your anticipated graduation month and year?")], { resolutions: new Map([["m", date]]) }))).toMatchObject({ action: "fill", value: "May 2030" });
    expect(only(plan([text("m", "Expected graduation date")], { resolutions: new Map([["m", date]]) }))).toMatchObject({ action: "fill", value: "2030-05-15" });
  });

  it("picks sentence Yes/No options in lists and checkbox groups", () => {
    const age = select("a", "Are you at least 18 years old?", ["Yes, I am at least 18 years of age.", "No, I am not at least 18 years of age."]);
    expect(only(plan([age], { resolutions: new Map([["a", resolved("age_18_or_older", true)]]) }))).toMatchObject({ action: "choose", value: "Yes, I am at least 18 years of age." });
    const sponsor = group("s", "Will you require sponsorship?", ["Yes, I will require sponsorship.", "No, I will not require sponsorship for an employment-based visa status."]);
    expect(only(plan([sponsor], { resolutions: new Map([["s", resolved("requires_sponsorship", false)]]) })))
      .toMatchObject({ action: "choose", value: "No, I will not require sponsorship for an employment-based visa status." });
    const office = group("o", "Are you open to working out of our Fixture Town Office 5 Days a Week?", ["Yes, but require relocation", "No"]);
    expect(only(plan([office], { resolutions: new Map([["o", resolved("work_arrangement", true)]]) })).action).toBe("pause");
    const visa = select("v", "Which visa will you need sponsorship for?", ["OPT", "H1B", "TN", "None", "Other"]);
    expect(only(plan([visa], { resolutions: new Map([["v", resolved("requires_sponsorship", false)]]) }))).toMatchObject({ action: "choose", value: "None" });
  });

  it("answers a U.S.-person Yes/No question from the saved export-control status", () => {
    const question = select("u", "To comply with U.S. Government space technology export regulations, applicant must be a U.S. citizen, lawful permanent resident, or protected individual.", ["Select One", "Yes", "No"]);
    const status = resolved("us_person_export_controls", "U.S. citizen");
    expect(only(plan([question], { resolutions: new Map([["u", status]]) }))).toMatchObject({ action: "choose", value: "Yes", basis: { kind: "fact", key: "us_person_export_controls" } });
  });

  it("picks the bachelor's level for a degree-level question while graduation is ahead", () => {
    const education = { school: "Example State University", degree: "B.A. Computer Science", graduation: { date: "2030-05-15", basis: { kind: "fact", key: "graduation_date", scope: "global" } as const } };
    const cases: Array<[RawControl, string]> = [
      [control({ tag: "input", type: "radio", id: "d", label: "What degree program are you actively enrolled in?", required: true, options: ["Undergraduate (B.S./B.A)", "Master's (M.S./M.A.)", "Ph.D.", "Non-Degree/Bootcamp/Certificate", "Not Currently Enrolled"] }), "Undergraduate (B.S./B.A)"],
      [select("d", "What degree are you taking currently?", ["Select One", "Undergraduate/Bachelor's Degree", "Postgraduate/Masters", "PhD"]), "Undergraduate/Bachelor's Degree"],
      [select("d", "Current Program Type", ["PhD", "Master's Degree", "JD", "MBA", "Bachelor's Degree", "High School", "Other"]), "Bachelor's Degree"],
      [group("d", "Degree Type", ["Undergraduate/Bachelors", "Master's", "PhD", "MBA"]), "Undergraduate/Bachelors"],
      [select("d", "If you are enrolled in university, what degree are you currently pursuing?", ["Bachelor's", "Master's", "MBA", "PhD", "Other (Associate’s, Bootcamp, etc)", "N/A"]), "Bachelor's"]
    ];
    for (const [field, value] of cases) {
      expect(only(plan([field], { education }))).toMatchObject({ action: "choose", value, basis: { kind: "profile", field: "degree" } });
    }
    const graduated = { ...education, graduation: { ...education.graduation, date: "2026-05-15" } };
    expect(only(plan([cases[0]![0]], { education: graduated })).action).toBe("pause");
    // Two undergraduate-level options (and no single bachelor's degree option): it pauses.
    const twoBachelors = select("d", "Current Program Type", ["Undergraduate", "Undergraduate (4-year)", "Master's Degree"]);
    expect(only(plan([twoBachelors], { education })).action).toBe("pause");
  });

  it("puts a saved SAT score in its bucket and picks the SAT test type, never typing the score into a test-type box", () => {
    const sat = resolved("sat_score", "1350");
    const buckets = select("s", "Provide your best result on SAT:", ["I don't have SAT score", "<1200", "1201 - 1300", "1301 - 1400", "1401 - 1500", "1501 - 1600"]);
    expect(only(plan([buckets], { resolutions: new Map([["s", sat]]) }))).toMatchObject({ action: "choose", value: "1301 - 1400", basis: { kind: "fact", key: "sat_score" } });
    expect(only(plan([select("t", "Test Type", ["SAT", "ACT"])], { resolutions: new Map([["t", sat]]) }))).toMatchObject({ action: "choose", value: "SAT" });
    const typed = only(plan([text("t", "Test Type")], { resolutions: new Map([["t", sat]]) }));
    expect(typed.action).toBe("pause");
    expect(typed.pause?.question).not.toContain("1350");
    expect(only(plan([text("s", "SAT Score")], { resolutions: new Map([["s", sat]]) }))).toMatchObject({ action: "fill", value: "1350" });
  });
});
