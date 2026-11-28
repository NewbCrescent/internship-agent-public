import { describe, expect, it } from "vitest";

import {
  answerKindFor,
  checkboxAnswer,
  genericSaveBlocker,
  matchOfferedOption,
  normalizeAnswerText,
  normalizeQuestionText,
  notSavedReasonText,
  questionAnswerNotSavedReasonSchema,
  questionReuseBlocked,
  questionSaveBlocker
} from "@internship-agent/domain";

// Question memory keys are exact: these cases pin what counts as "the same question".
describe("question-memory normalization", () => {
  it("treats case, punctuation, and a trailing required marker as the same question", () => {
    expect(normalizeQuestionText("Do you have experience with Python? *"))
      .toBe(normalizeQuestionText("do you have experience with python"));
    expect(normalizeQuestionText("Do you have experience with Python? *")).toBe("do you have experience with python");
  });

  it("drops trailing (optional), (required), - required, and repeated * markers", () => {
    expect(normalizeQuestionText("Python experience (Optional)")).toBe("python experience");
    expect(normalizeQuestionText("Python experience (required)")).toBe("python experience");
    expect(normalizeQuestionText("Years of experience - required")).toBe("years of experience");
    expect(normalizeQuestionText("Years of experience * *")).toBe("years of experience");
    expect(normalizeQuestionText("Years of experience (optional) *")).toBe("years of experience");
  });

  it("keeps a required that is part of the question", () => {
    expect(normalizeQuestionText("Is a visa required for travel")).toBe("is a visa required for travel");
  });

  it("removes accents and collapses whitespace", () => {
    expect(normalizeQuestionText("Résumé gaps?")).toBe("resume gaps");
    expect(normalizeQuestionText("  Which   tools\n do you   use?  ")).toBe("which tools do you use");
  });

  it("is idempotent", () => {
    for (const text of ["Do you have experience with Python? *", "Résumé gaps?", "C++ or C#? (optional)", "Years - required"]) {
      const once = normalizeQuestionText(text);
      expect(normalizeQuestionText(once)).toBe(once);
      expect(normalizeAnswerText(normalizeAnswerText(text))).toBe(normalizeAnswerText(text));
    }
  });

  it("keeps C++ and C# apart from C", () => {
    expect(normalizeQuestionText("Experience with C++?")).not.toBe(normalizeQuestionText("Experience with C?"));
    expect(normalizeQuestionText("Experience with C#?")).not.toBe(normalizeQuestionText("Experience with C?"));
    expect(normalizeQuestionText("Experience with C#?")).not.toBe(normalizeQuestionText("Experience with C++?"));
    expect(normalizeAnswerText("C++")).toBe("c plus plus");
    expect(normalizeAnswerText("C#")).toBe("c sharp");
  });
});

describe("exact option matching", () => {
  it("matches exactly one option by normalized text", () => {
    expect(matchOfferedOption(["Yes", "No"], "yes")).toBe("Yes");
    expect(matchOfferedOption(["Yes", "No"], " NO. ")).toBe("No");
  });

  it("never matches a similar option, several options, nothing, or an empty answer", () => {
    expect(matchOfferedOption(["Yes, 2+ years", "No"], "Yes")).toBeNull();
    expect(matchOfferedOption(["Yes", "yes."], "YES")).toBeNull();
    expect(matchOfferedOption([], "Yes")).toBeNull();
    expect(matchOfferedOption(["Yes", "No"], "")).toBeNull();
    expect(matchOfferedOption(["Yes", "No"], "?!")).toBeNull();
  });

  it("reads checkbox answers as yes or no only", () => {
    for (const yes of ["yes", "Y", "true", "checked", "Agree", "I agree"]) expect(checkboxAnswer(yes)).toBe("Yes");
    for (const no of ["no", "N", "false", "unchecked"]) expect(checkboxAnswer(no)).toBe("No");
    expect(checkboxAnswer("maybe")).toBeNull();
    expect(checkboxAnswer("")).toBeNull();
  });

  it("stores select, radio, and checkbox answers as options", () => {
    expect(answerKindFor("select")).toBe("option");
    expect(answerKindFor("radio")).toBe("option");
    expect(answerKindFor("checkbox")).toBe("option");
    expect(answerKindFor("text")).toBe("text");
    expect(answerKindFor(undefined)).toBe("text");
  });
});

describe("never-save rules", () => {
  const base = { fieldId: "q", fieldKind: "text" as const };
  const reason = (label: string, extra: Partial<Parameters<typeof genericSaveBlocker>[0]> = {}) =>
    genericSaveBlocker({ ...base, label, ...extra });

  it("never saves a question naming the posting's company", () => {
    expect(reason("Have you used Northstar Systems products before?", { companyName: "Northstar Systems Inc." })).toBe("company_named");
  });

  it("never saves why, interest, and motivation questions", () => {
    expect(reason("Why this internship?")).toBe("why_interest");
    expect(reason("What interests you about the role?")).toBe("why_interest");
    expect(reason("What motivates you to apply?")).toBe("why_interest");
  });

  it("never saves employer- or role-specific questions", () => {
    expect(reason("Have you applied to this company before?")).toBe("company_specific");
    expect(reason("What are your salary expectations?")).toBe("company_specific");
    expect(reason("Were you referred by an employee?")).toBe("company_specific");
  });

  it("never saves consents and acknowledgements", () => {
    expect(reason("I acknowledge the privacy policy", { fieldKind: "checkbox" })).toBe("consent");
  });

  it("never saves sensitive questions", () => {
    expect(reason("Your favorite tools", { sensitive: true })).toBe("sensitive");
    expect(reason("Date of birth")).toBe("sensitive");
    expect(reason("Are you a U.S. citizen?", { fieldKind: "select" })).toBe("sensitive");
    // (Track 82) LGBTQ+ membership and "Latine" wordings are self-identification too.
    expect(reason("LGBTQIA+ identity")).toBe("sensitive");
    expect(reason("Are you Latine?")).toBe("sensitive");
    // (Track 82, round 3) Plural "veterans" wordings too.
    expect(reason("Are you affiliated with a veterans group?")).toBe("sensitive");
  });

  it("never saves contact details", () => {
    expect(reason("Backup address", { fieldKind: "email" })).toBe("contact");
    expect(reason("Mobile number")).toBe("contact");
  });

  it("never saves coursework or course questions", () => {
    expect(questionSaveBlocker({ label: "Which online courses have you completed?", fieldId: "q" })).toBe("coursework");
    expect(questionSaveBlocker({ label: "Relevant coursework", fieldId: "q" })).toBe("coursework");
    expect(questionSaveBlocker({ label: "Do you have experience with Python?", fieldId: "q" })).toBeNull();
  });

  it("never saves essays, voice-draft pauses, or long answers", () => {
    expect(reason("Anything else?", { fieldKind: "textarea" })).toBe("essay");
    expect(reason("Your strongest tool", { hasDraft: true })).toBe("essay");
    expect(reason("Your strongest tool", { answer: "x".repeat(201) })).toBe("essay");
    expect(reason("Your strongest tool", { answer: "x".repeat(200) })).toBeNull();
    expect(reason("Describe a project you are proud of")).toBe("essay");
  });

  it("never saves Workday error reports, uploads, safeguards, or wordless questions and answers", () => {
    expect(genericSaveBlocker({ label: "Errors", fieldId: "My Information::workday-errors" })).toBe("workday_error");
    // Per-error Workday pauses carry Workday's text in their labels; their answers are for the run only.
    expect(genericSaveBlocker({ label: "Phone: The field Phone is required and must have a value.", fieldId: "My Information::workday-error::formField-phone" })).toBe("workday_error");
    expect(genericSaveBlocker({ label: "My Information: Something went wrong.", fieldId: "My Information::workday-error-2" })).toBe("workday_error");
    expect(genericSaveBlocker({ label: "Preferred phone label", fieldId: "My Information::formField-phone" })).not.toBe("workday_error");
    expect(reason("Portfolio", { upload: true })).toBe("upload");
    expect(reason("Portfolio", { fieldKind: "file" })).toBe("upload");
    expect(reason("Portfolio", { safeguard: true })).toBe("safeguard");
    expect(reason("???")).toBe("not_reusable");
    expect(reason("Your strongest tool", { answer: "?!" })).toBe("not_reusable");
  });

  it("saves generic questions", () => {
    expect(reason("Do you have experience with Python?", { fieldKind: "select", answer: "Yes" })).toBeNull();
    expect(reason("Which programming languages do you use most?", { answer: "Python, TypeScript" })).toBeNull();
  });

  it("refuses reuse on the same rules", () => {
    expect(questionReuseBlocked({ id: "q", label: "Do you have experience with Python?", kind: "select" }, "Northstar Systems")).toBe(false);
    expect(questionReuseBlocked({ id: "q", label: "Have you used Northstar Systems products?", kind: "select" }, "Northstar Systems")).toBe(true);
    expect(questionReuseBlocked({ id: "q", label: "Why us?", kind: "text" }, null)).toBe(true);
    expect(questionSaveBlocker({ label: "Do you have experience with Python?", fieldId: "q" })).toBeNull();
  });

  it("explains every reason without an answer", () => {
    for (const key of questionAnswerNotSavedReasonSchema.options) expect(notSavedReasonText(key).length).toBeGreaterThan(5);
  });
});
