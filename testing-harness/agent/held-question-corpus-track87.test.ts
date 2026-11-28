import { describe, expect, it } from "vitest";

import { DeterministicQuestionMapper } from "@internship-agent/agent";
import { planAutofill, recognizeForm, type RawControl } from "@internship-agent/browser";
import type { QuestionContext } from "@internship-agent/domain";

/**
 * Track 87 regression corpus (2026-11-28): the number of previous internships, outstanding offers or deadlines, and
 * the Greenhouse education "Degree" list held on five runs in pass 37. Wordings and option lists follow the held
 * questions, with company names replaced by fictional ones; every candidate value here is fictional.
 */

const mapper = new DeterministicQuestionMapper();
const US: QuestionContext = { postingCountryCode: "US", companyName: "Fixture Co" };
const mappingOf = async (question: string) => mapper.map(question, US);
const keyOf = async (question: string) => {
  const mapped = await mappingOf(question);
  return mapped.status === "MAPPED" ? mapped.key : mapped.status;
};

describe("held-question corpus: previous internships (Track 87)", () => {
  it("maps count and at-least-one wordings to the saved number of previous internships", async () => {
    for (const question of [
      "How many internships have you completed before this summer?",
      "How many internships have you completed?",
      "Number of prior internships",
      "Have you completed at least one previous internship?",
      "Have you ever interned before?",
      "Do you have any prior internship experience?"
    ]) {
      expect(await mappingOf(question), question).toMatchObject({ status: "MAPPED", key: "prior_internships_count", scope: { kind: "global" } });
    }
  });

  it("leaves company-named, field-named, and co-op wordings to their own rules", async () => {
    expect(await keyOf("Have you interned at Fixture Co before?")).toBe("previously_worked_here");
    expect(await keyOf("Have you ever interned with us before?")).toBe("previously_worked_here");
    for (const question of [
      "How many software engineering internships have you completed?",
      "How many internships or co-ops have you completed?",
      "Describe your previous internship experience."
    ]) {
      expect(await keyOf(question), question).not.toBe("prior_internships_count");
    }
  });
});

describe("held-question corpus: outstanding offers or deadlines (Track 87)", () => {
  it("maps a Yes/No about the candidate's outstanding offers or deadlines", async () => {
    for (const question of [
      "Do you have any outstanding job offers or deadlines right now?",
      "Do you have any outstanding offers or deadlines?",
      "Are you currently considering other offers?",
      "Do you have any competing offers?",
      "Do you have any deadlines we should be aware of?",
      "Are you holding any outstanding offers?",
      "Do you currently have any offers from other firms or deadlines we should be aware of?"
    ]) {
      const mapped = await mappingOf(question);
      expect(mapped, question).toMatchObject({ status: "MAPPED", key: "has_outstanding_offers", scope: { kind: "global" } });
      expect(mapped, question).not.toHaveProperty("narrower");
    }
  });

  it("marks a question that also asks to name them as answered only by a saved No", async () => {
    for (const question of [
      "Do you have any outstanding offers or deadlines? If so, please list the companies and deadlines.",
      "Are you currently considering other offers? If yes, which companies?",
      "Do you currently have an offer? If so, what is your deadline to make a decision by?",
      "Do you have an active offer deadline or another recruiting-process deadline we should be aware of? If yes, please share the deadline date and any relevant context."
    ]) {
      expect(await mappingOf(question), question).toMatchObject({ status: "MAPPED", key: "has_outstanding_offers", narrower: true });
    }
  });

  it("never maps a follow-up that only asks to name them, or an offer the employer makes", async () => {
    for (const question of [
      "Please list your outstanding offers and their deadlines.",
      "If offered this position, would you accept an offer?",
      "Do you have a return offer from a previous internship?",
      "Are there any deadlines or timeline considerations we should be aware of?",
      "Do you have any school deadlines during the internship?",
      "Do you have an offer letter from your current employer?"
    ]) {
      expect(await keyOf(question), question).not.toBe("has_outstanding_offers");
    }
  });
});

type Resolution = { status: "RESOLVED"; key: string; scope: string; display: string; value: boolean | string };
const resolved = (key: string, value: boolean | string): Resolution => ({ status: "RESOLVED", key, scope: "global", display: typeof value === "boolean" ? (value ? "Yes" : "No") : value, value });
const list = (id: string, label: string, options: string[]): RawControl => ({ tag: "select", ref: id, id, label, required: true, options });
const text = (id: string, label: string): RawControl => ({ tag: "input", type: "text", id, label, required: true });
const PROFILE = { fullName: "Avery Example", fieldOfStudy: "Computer Science" };

function planWith(controls: RawControl[], byLabel: Record<string, Resolution>, education?: { school: string; degree: string }) {
  const form = recognizeForm("https://boards.greenhouse.io/fixture/jobs/8700000", "Apply", controls);
  const resolutions = new Map(form.fields.filter((field) => byLabel[field.label]).map((field) => [field.id, byLabel[field.label]!]));
  const result = planAutofill(form, {
    profile: PROFILE, resolutions, packageAnswers: [], variantId: null,
    ...(education ? { education } : {}),
    standing: { acceptDataConsent: true, signAttestations: true, today: "2026-11-28" }
  });
  const decisions = new Map(form.fields.map((field, index) => [field.label, result.decisions[index]!]));
  return (label: string) => decisions.get(label) ?? null;
}

describe("held-question corpus: planner rows (Track 87)", () => {
  const atLeastOne = "Have you completed at least one previous internship?";
  const howMany = "How many internships have you completed?";

  it("chooses Yes or No for an at-least-one question from the saved count, and types the word in a text box", () => {
    expect(planWith([list("q", atLeastOne, ["Yes", "No"])], { [atLeastOne]: resolved("prior_internships_count", "4") })(atLeastOne))
      .toMatchObject({ action: "choose", value: "Yes", basis: { kind: "fact", key: "prior_internships_count" } });
    expect(planWith([list("q", atLeastOne, ["Yes", "No"])], { [atLeastOne]: resolved("prior_internships_count", "0") })(atLeastOne))
      .toMatchObject({ action: "choose", value: "No" });
    expect(planWith([text("q", atLeastOne)], { [atLeastOne]: resolved("prior_internships_count", "4") })(atLeastOne))
      .toMatchObject({ action: "fill", value: "Yes" });
    expect(planWith([list("q", atLeastOne, ["Yes, one", "Yes, more than one", "No"])], { [atLeastOne]: resolved("prior_internships_count", "4") })(atLeastOne))
      .toMatchObject({ action: "pause" });
  });

  it("chooses the one count option holding the saved number, and types the number in a text box", () => {
    expect(planWith([list("q", howMany, ["Select...", "0", "1", "2", "3+"])], { [howMany]: resolved("prior_internships_count", "4") })(howMany))
      .toMatchObject({ action: "choose", value: "3+" });
    expect(planWith([list("q", howMany, ["0", "1", "2", "3+"])], { [howMany]: resolved("prior_internships_count", "1") })(howMany))
      .toMatchObject({ action: "choose", value: "1" });
    expect(planWith([text("q", howMany)], { [howMany]: resolved("prior_internships_count", "4") })(howMany))
      .toMatchObject({ action: "fill", value: "4" });
    expect(planWith([list("q", howMany, ["0", "1", "2"])], { [howMany]: resolved("prior_internships_count", "4") })(howMany))
      .toMatchObject({ action: "pause" });
  });

  it("chooses the saved outstanding-offers No on a Yes/No list", () => {
    const question = "Do you have any outstanding job offers or deadlines right now?";
    expect(planWith([list("q", question, ["Yes", "No"])], { [question]: resolved("has_outstanding_offers", false) })(question))
      .toMatchObject({ action: "choose", value: "No" });
  });

  it("chooses one option of Greenhouse's Degree list offering both Bachelors and Bachelor's Degree", () => {
    const options = ["Associates", "Associate's Degree", "Bachelors", "Bachelor's Degree", "High School", "Masters", "Master's Degree", "Other"];
    const education = { school: "Example State University", degree: "B.A. Computer Science" };
    expect(planWith([list("degree--0", "Degree", options)], {}, education)("Degree"))
      .toMatchObject({ action: "choose", value: "Bachelors", basis: { kind: "profile", field: "degree" } });
    // Two bachelor's options that differ in more than spelling still ask.
    expect(planWith([list("degree--0", "Degree", ["Bachelor's Degree", "Bachelor's Level Degree", "Masters"])], {}, education)("Degree"))
      .toMatchObject({ action: "pause" });
  });
});
