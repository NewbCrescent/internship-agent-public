import { describe, expect, it } from "vitest";

import { planAutofill, type FieldResolution } from "@internship-agent/browser";
import type { BrowserField, RecognizedForm } from "@internship-agent/domain";

import { answeredPauseDecision } from "../../packages/agent/src/question-answers";

// Autofill planning with question-memory answers: pure planner checks, no database or browser.
const ANSWER_ID = "6f1d0c1e-8f3a-4c2b-9d7e-1a2b3c4d5e6f";

function plan(fields: BrowserField[], resolutions: Array<[string, FieldResolution]>) {
  const form: RecognizedForm = { url: "https://boards.greenhouse.io/example/jobs/1", title: "Apply", fields };
  return planAutofill(form, { profile: {}, resolutions: new Map(resolutions), packageAnswers: [], variantId: null });
}

function remembered(answer: string, answerKind: "text" | "option"): FieldResolution {
  return { status: "REMEMBERED_ANSWER", answerId: ANSWER_ID, answer, answerKey: answer.toLowerCase(), answerKind };
}

const basis = { kind: "question_answer", answerId: ANSWER_ID };

describe("autofill planning with question memory", () => {
  it("chooses the one offered option that matches the saved answer", () => {
    const field: BrowserField = { id: "python", label: "Do you have experience with Python?", kind: "select", required: true, options: ["Yes", "No"] };
    const [decision] = plan([field], [["python", remembered("Yes", "option")]]).decisions;
    expect(decision).toMatchObject({ action: "choose", value: "Yes", basis });
  });

  it("pauses when no offered option matches, without echoing the saved answer", () => {
    const field: BrowserField = { id: "python", label: "Do you have experience with Python?", kind: "select", required: true, options: ["Yes, 2+ years", "No"] };
    const result = plan([field], [["python", remembered("Yes", "option")]]);
    expect(result.decisions[0]?.action).toBe("pause");
    const other = plan([{ ...field, options: ["Yes", "No"] }], [["python", remembered("Quokka", "option")]]);
    expect(other.decisions[0]?.action).toBe("pause");
    expect(other.decisions[0]?.pause?.question).not.toContain("Quokka");
    expect(other.decisions[0]?.reason).not.toContain("Quokka");
    expect(other.pauses[0]?.question).not.toContain("Quokka");
  });

  it("fills a text field with the saved text verbatim", () => {
    const field: BrowserField = { id: "langs", label: "Which programming languages do you use most?", kind: "text", required: true };
    const [decision] = plan([field], [["langs", remembered("Python, TypeScript", "text")]]).decisions;
    expect(decision).toMatchObject({ action: "fill", value: "Python, TypeScript", basis });
  });

  it("never fills free text from a saved option answer", () => {
    const required: BrowserField = { id: "langs", label: "Which programming languages do you use most?", kind: "text", required: true };
    const [paused] = plan([required], [["langs", remembered("Yes", "option")]]).decisions;
    expect(paused?.action).toBe("pause");
    expect(paused?.pause?.question).toBe(`How should "${required.label}" be answered?`);
    const [skipped] = plan([{ ...required, required: false }], [["langs", remembered("Yes", "option")]]).decisions;
    expect(skipped?.action).toBe("skip");
  });

  it("checks or leaves a single checkbox from a saved yes or no", () => {
    const field: BrowserField = { id: "relocate", label: "Open to working on site?", kind: "checkbox", required: true };
    const [checked] = plan([field], [["relocate", remembered("Yes", "option")]]).decisions;
    expect(checked).toMatchObject({ action: "check", value: "true", basis });
    const [left] = plan([field], [["relocate", remembered("No", "option")]]).decisions;
    expect(left?.action).toBe("skip");
  });

  it("chooses a checkbox group's one matching option from a saved answer, else pauses", () => {
    const field: BrowserField = { id: "tools", label: "Which tools do you use?", kind: "checkbox", required: true, options: ["Git", "Docker"] };
    const [decision] = plan([field], [["tools", remembered("Git", "option")]]).decisions;
    expect(decision).toMatchObject({ action: "choose", value: "Git", basis });
    const [unmatched] = plan([field], [["tools", remembered("Kubernetes", "option")]]).decisions;
    expect(unmatched?.action).toBe("pause");
    expect(unmatched?.basis).toBeNull();
  });

  it("keeps the number guard: a saved phrase never fills a number box", () => {
    const field: BrowserField = { id: "years", label: "Years of Python experience", kind: "number", required: true };
    const [decision] = plan([field], [["years", remembered("about five", "text")]]).decisions;
    expect(decision?.action).toBe("pause");
    const [filled] = plan([field], [["years", remembered("5", "text")]]).decisions;
    expect(filled).toMatchObject({ action: "fill", value: "5", basis });
  });

  it("records the field kind and options on pause records", () => {
    const field: BrowserField = { id: "python", label: "Do you have experience with Python?", kind: "select", required: true, options: ["Yes", "No"] };
    const result = plan([field], []);
    expect(result.pauses[0]).toMatchObject({ fieldId: "python", fieldKind: "select", options: ["Yes", "No"] });
    const text = plan([{ id: "t", label: "Favorite editor", kind: "text", required: true }], []);
    expect(text.pauses[0]?.fieldKind).toBe("text");
    expect(text.pauses[0]?.options).toBeUndefined();
  });
});

describe("answered pause decisions", () => {
  const factBasis = { kind: "fact", key: "custom", scope: "global" } as const;

  it("chooses a type-ahead's answer from its suggestions instead of typing it", () => {
    const field: BrowserField = { id: "office", label: "Preferred office", kind: "text", required: true, widget: "autocomplete" };
    expect(answeredPauseDecision(field, "  Seattle  ", factBasis)).toMatchObject({ action: "choose", value: "Seattle", basis: factBasis });
    const listed: BrowserField = { ...field, kind: "select", options: ["Seattle, WA", "Austin, TX"] };
    expect(answeredPauseDecision(listed, "seattle, wa", null)).toMatchObject({ action: "choose", value: "Seattle, WA" });
    expect(answeredPauseDecision(field, "   ", null)).toBeNull();
  });

  it("chooses a radio set's or checkbox group's matching option and never types into it", () => {
    const radio: BrowserField = { id: "cards[1][field0]", label: "Are you authorized to work here?", kind: "radio", required: true, options: ["Yes", "No"] };
    expect(answeredPauseDecision(radio, "yes", null)).toMatchObject({ action: "choose", value: "Yes", reason: "The candidate answered this pause during review." });
    expect(answeredPauseDecision(radio, "Maybe later", null)).toBeNull();
    const group: BrowserField = { id: "tools", label: "Which tools do you use?", kind: "checkbox", required: true, options: ["Git", "Docker"] };
    expect(answeredPauseDecision(group, "docker", null)).toMatchObject({ action: "choose", value: "Docker" });
    expect(answeredPauseDecision(group, "Kubernetes", null)).toBeNull();
    const bare: BrowserField = { id: "auth", label: "Work authorization", kind: "select", required: true };
    expect(answeredPauseDecision(bare, "Yes", null)).toBeNull();
  });

  it("checks a single box for yes, leaves it for no, and reopens anything else", () => {
    const box: BrowserField = { id: "relocate", label: "Open to working on site?", kind: "checkbox", required: true };
    expect(answeredPauseDecision(box, "Yes", factBasis)).toMatchObject({ action: "check", value: "true", basis: factBasis });
    expect(answeredPauseDecision(box, "no", factBasis)).toMatchObject({ action: "skip", value: null, basis: null });
    expect(answeredPauseDecision(box, "maybe", null)).toBeNull();
  });

  it("fills a number box only with a number and never answers an upload", () => {
    const years: BrowserField = { id: "years", label: "Years of Python experience", kind: "number", required: true };
    expect(answeredPauseDecision(years, "abc", null)).toBeNull();
    expect(answeredPauseDecision(years, "3", null)).toMatchObject({ action: "fill", value: "3" });
    const upload: BrowserField = { id: "cover", label: "Cover letter", kind: "file", required: true };
    expect(answeredPauseDecision(upload, "See attached", null)).toBeNull();
    const text: BrowserField = { id: "editor", label: "Favorite editor", kind: "text", required: true };
    expect(answeredPauseDecision(text, "Vim", null)).toMatchObject({ action: "fill", value: "Vim" });
  });
});
