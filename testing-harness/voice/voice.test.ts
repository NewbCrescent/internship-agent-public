import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyVoiceDrafts, createVoiceDrafter, type DraftRequest, type ModelProvider, type StructuredRequest } from "@internship-agent/agent";
import { isDraftableQuestion, type FillDecision, type JobPosting, type PauseRecord, type RecognizedForm } from "@internship-agent/domain";
import {
  analyzeTexts,
  categoryGuideSection,
  findReferenceOverlap,
  loadVoiceCorpus,
  parseVoiceGateOutput,
  selectVoiceExamples,
  splitSentences,
  type VoiceCorpus,
  type VoiceGateResult,
  type VoiceRecord
} from "@internship-agent/voice";

// Synthetic, fictional writing samples: they prove contracts, not voice quality.
const record = (id: string, category: VoiceRecord["category"], source: string, text: string): VoiceRecord =>
  ({ id, category, title: `Sample ${id}`, source_file: source, word_count: text.split(/\s+/).length, text });
const filler = "I started with the part that confused me, which was the scheduler, and I kept rewriting it until the queue made sense to me.";
const records: VoiceRecord[] = [
  record("s-1", "applications_and_professional", "a.txt", `Internship application answer. ${filler} ${filler} The lighthouse keeper counted seventeen gulls every morning before breakfast.`),
  record("s-2", "applications_and_professional", "a.txt", `Second application answer. ${filler} ${filler}`),
  record("s-3", "applications_and_professional", "b.txt", `Scholarship statement. ${filler} ${filler} ${filler}`),
  record("s-4", "technical_and_project_writing", "c.txt", `Project write-up about software. ${filler}`)
];
const corpus: VoiceCorpus = {
  records,
  voiceProfile: "Direct, earnest, reasons out loud.",
  categoryGuide: "# Category guide\n\n## `applications_and_professional`\nConcrete motives.\n\n## `technical_and_project_writing`\nBuild steps.\n",
  auditRubric: "Check cadence.",
  authorshipGate: "Use only supplied facts."
};

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("voice corpus and style tools", () => {
  it("loads a complete local corpus and refuses an incomplete one", () => {
    const directory = mkdtempSync(join(tmpdir(), "internship-agent-voice-"));
    temporary.push(directory);
    expect(loadVoiceCorpus(directory)).toBeNull();
    writeFileSync(join(directory, "reference-dataset.jsonl"), records.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    for (const name of ["voice-profile.md", "category-guide.md", "audit-rubric.md"]) writeFileSync(join(directory, name), "# guide\n");
    expect(loadVoiceCorpus(directory)).toBeNull();
    writeFileSync(join(directory, "authorship-gate.md"), "# gate\n");
    expect(loadVoiceCorpus(directory)?.records.map((entry) => entry.id)).toEqual(["s-1", "s-2", "s-3", "s-4"]);
  });

  it("reads one category-guide section", () => {
    expect(categoryGuideSection(corpus.categoryGuide, "applications_and_professional")).toBe("## `applications_and_professional`\nConcrete motives.");
  });

  it("selects examples from the category, preferring distinct sources within the word budget", () => {
    const selected = selectVoiceExamples(records, "applications_and_professional", "internship application", { count: 2 });
    expect(selected.map((entry) => entry.source_file)).toEqual(["a.txt", "b.txt"]);
    expect(selectVoiceExamples(records, "applications_and_professional", "internship", { count: 8, maxWords: 100 })).toHaveLength(1);
  });

  it("splits sentences around abbreviations and decimals and measures them", () => {
    expect(splitSentences("Dr. Lee ran 3.5 miles. It rained! Why?")).toEqual(["Dr. Lee ran 3.5 miles.", "It rained!", "Why?"]);
    const metrics = analyzeTexts(["I built it. I tested it because it broke.\n\nThen I shipped it."]);
    expect(metrics.sentenceCount).toBe(3);
    expect(metrics.paragraphCount).toBe(2);
    expect(metrics.transitionCount).toBe(1);
    expect(metrics.sentenceFirstTokenMostCommon).toBe("i");
  });

  it("flags copied eight-word corpus wording", () => {
    const overlap = findReferenceOverlap("Oddly, the lighthouse keeper counted seventeen gulls every morning before breakfast too.", records);
    expect(overlap[0]?.referenceIds).toBe("s-1");
    expect(findReferenceOverlap("A completely different sentence about compilers and parsers.", records)).toEqual([]);
  });

  it("parses the voice gate's JSON for one draft", () => {
    const result = parseVoiceGateOutput(JSON.stringify({
      samples: { stdin: {
        detectors: { raid: { score: 0.2, ai_likeness_percentile: 40, passed: true }, desklib: { score: 0.1, ai_likeness_percentile: 30, passed: true }, fastdetect: { score: 0.3, ai_likeness_percentile: 50, passed: true } },
        all_three_passed: true, average_ai_likeness_percentile: 40, target_average: 65, voice_proxy_passed: true
      } }
    }));
    expect(result).toMatchObject({ passed: true, averagePercentile: 40, targetAverage: 65 });
    expect(Object.keys(result.detectors)).toEqual(["raid", "desklib", "fastdetect"]);
    expect(() => parseVoiceGateOutput("{}")).toThrow();
  });

  it("drafts only open-ended prose, never facts, attestations, or protected answers", () => {
    expect(isDraftableQuestion({ label: "Why do you want to work at Aurora?", kind: "textarea" })).toBe(true);
    expect(isDraftableQuestion({ label: "Describe a project you are proud of", kind: "text" })).toBe(true);
    expect(isDraftableQuestion({ label: "Cover letter", kind: "textarea" })).toBe(true);
    // A field with no readable label (Oracle's "Unlabeled textarea control 2") is never drafted.
    expect(isDraftableQuestion({ label: "Unlabeled textarea control 2", kind: "textarea" })).toBe(false);
    for (const label of ["What is your expected graduation date?", "Are you authorized to work in the US?", "Gender identity",
      "Mailing address", "Desired salary", "Please describe your disability status", "I certify that the information is true",
      "Why did you choose your major?", "LinkedIn profile"]) {
      expect(isDraftableQuestion({ label, kind: "textarea" }), label).toBe(false);
    }
    expect(isDraftableQuestion({ label: "Nickname", kind: "text" })).toBe(false);
    expect(isDraftableQuestion({ label: "Why do you want to work here?", kind: "select" })).toBe(false);
  });
});

type Draft = { insufficientMaterial: boolean; text: string; claims: Array<{ sentence: string; sources: string[] }> };

function fakeProvider(drafts: Draft[]): ModelProvider & { requests: StructuredRequest<unknown>[] } {
  const requests: StructuredRequest<unknown>[] = [];
  return {
    available: true,
    requests,
    async complete<T>(request: StructuredRequest<T>) {
      requests.push(request as StructuredRequest<unknown>);
      const value = drafts[Math.min(requests.length - 1, drafts.length - 1)]!;
      return { value: request.schema.parse(value), model: "fake", inputTokens: 1, outputTokens: 1, reasoningTokens: 0, durationMs: 1 };
    }
  };
}

const gateResult = (passed: boolean, averagePercentile: number): VoiceGateResult => ({
  passed, allThreePassed: passed, averagePercentile, targetAverage: 65,
  detectors: { raid: { score: 0.1, percentile: averagePercentile, passed }, desklib: { score: 0.1, percentile: averagePercentile, passed: true }, fastdetect: { score: 0.1, percentile: averagePercentile, passed: true } }
});
function fakeGate(results: VoiceGateResult[]) {
  const texts: string[] = [];
  const gate = async (text: string) => { texts.push(text); return results[Math.min(texts.length - 1, results.length - 1)]!; };
  return Object.assign(gate, { texts });
}

const request: DraftRequest = {
  question: "Why do you want to intern at Aurora Labs?",
  companyName: "Aurora Labs",
  title: "Software Engineering Intern",
  postingText: "Aurora Labs builds developer tools. Interns join the platform team for summer 2027.",
  sources: [{ id: "resume:r1", text: "Campus Robotics | Software Lead | Rewrote the scheduler in Python" }],
  jobId: null
};
const grounded = (text: string): Draft => ({ insufficientMaterial: false, text, claims: [{ sentence: text, sources: ["resume:r1", "posting"] }] });

describe("voice drafting loop", () => {
  it("fills with the first draft when it is grounded and passes the gate", async () => {
    const gate = fakeGate([gateResult(true, 40)]);
    const outcome = await createVoiceDrafter({ provider: fakeProvider([grounded("I rewrote a scheduler in Python, and Aurora's platform team builds the tools I wanted then.")]), corpus, gate })(request);
    expect(outcome).toMatchObject({ status: "filled", gate: { passed: true, revisions: 0 } });
    expect(gate.texts).toHaveLength(1);
  });

  it("revises with gate feedback and fills once a revision passes", async () => {
    const provider = fakeProvider([grounded("Draft one about the Python scheduler."), grounded("Draft two about the Python scheduler."), grounded("Draft three about the Python scheduler.")]);
    const outcome = await createVoiceDrafter({ provider, corpus, gate: fakeGate([gateResult(false, 90), gateResult(false, 80), gateResult(true, 50)]) })(request);
    expect(outcome).toMatchObject({ status: "filled", text: "Draft three about the Python scheduler.", gate: { revisions: 2 } });
    expect(provider.requests.map((entry) => entry.task)).toEqual(["application.answer_draft", "application.voice_revision", "application.voice_revision"]);
    expect(provider.requests[1]!.input).toContain("voice gate did not pass");
  });

  it("leaves the field blank after five failed revisions and keeps the best version", async () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const drafts = names.map((name) => grounded(`Draft ${name} about the Python scheduler.`));
    const provider = fakeProvider(drafts);
    const outcome = await createVoiceDrafter({ provider, corpus, gate: fakeGate([90, 70, 85, 60, 95, 75].map((score) => gateResult(false, score))) })(request);
    expect(provider.requests).toHaveLength(6);
    expect(outcome.status).toBe("blank");
    if (outcome.status !== "blank") return;
    expect(outcome.draft.text).toBe("Draft delta about the Python scheduler.");
    expect(outcome.draft.gate).toMatchObject({ passed: false, averagePercentile: 60, revisions: 5 });
    expect(outcome.draft.reason).toContain("5 revisions");
  });

  it("never gates or keeps a draft with an unsupported claim or an invented number", async () => {
    const provider = fakeProvider([
      { insufficientMaterial: false, text: "I led a team at Aurora.", claims: [{ sentence: "I led a team at Aurora.", sources: [] }] },
      grounded("I cut scheduler latency by 40% in Python."),
      { insufficientMaterial: false, text: "Scheduler work.", claims: [{ sentence: "Scheduler work.", sources: ["resume:missing"] }] }
    ]);
    const gate = fakeGate([gateResult(true, 10)]);
    const outcome = await createVoiceDrafter({ provider, corpus, gate })(request);
    expect(gate.texts).toEqual([]);
    expect(outcome).toMatchObject({ status: "blank", draft: { text: "", gate: null } });
    expect(provider.requests[1]!.input).toContain("Unsupported claim");
    expect(provider.requests[2]!.input).toContain("40%");
    expect(provider.requests[2]!.input).toContain("does not appear in your material");
  });

  it("does not gate a draft that copies corpus wording", async () => {
    const gate = fakeGate([gateResult(true, 10)]);
    const provider = fakeProvider([
      grounded("In Python, the lighthouse keeper counted seventeen gulls every morning before breakfast."),
      grounded("I rewrote the scheduler in Python.")
    ]);
    const outcome = await createVoiceDrafter({ provider, corpus, gate })(request);
    expect(gate.texts).toEqual(["I rewrote the scheduler in Python."]);
    expect(outcome.status).toBe("filled");
    expect(provider.requests[1]!.input).toContain("reference_overlap");
  });

  it("does not fill when the gate cannot run, and stops when the material is insufficient", async () => {
    const failing = Object.assign(async () => { throw new Error("uv not found"); }, {});
    const outcome = await createVoiceDrafter({ provider: fakeProvider([grounded("I rewrote the scheduler in Python.")]), corpus, gate: failing })(request);
    expect(outcome).toMatchObject({ status: "blank", draft: { text: "I rewrote the scheduler in Python.", gate: null } });
    if (outcome.status === "blank") expect(outcome.draft.reason).toContain("could not run");

    const insufficient = await createVoiceDrafter({ provider: fakeProvider([{ insufficientMaterial: true, text: "", claims: [] }]), corpus, gate: fakeGate([gateResult(true, 1)]) })(request);
    expect(insufficient).toMatchObject({ status: "blank", draft: { text: "" } });
  });
});

describe("voice drafts in a fill plan", () => {
  const form: RecognizedForm = {
    url: "https://job-boards.greenhouse.io/aurora/jobs/1", title: "Apply",
    fields: [
      { id: "why", label: "Why do you want to work at Aurora Labs?", kind: "textarea", required: true },
      { id: "eeo", label: "Gender identity", kind: "select", required: true, options: ["A", "B"] },
      { id: "badge", label: "What name should appear on your badge?", kind: "text", required: true },
      { id: "exp", label: "Describe your most relevant experience.", kind: "textarea", required: true }
    ]
  };
  const pause = (fieldId: string, label: string, sensitive = false): PauseRecord => ({
    fieldId, label, question: `How should "${label}" be answered?`, suggestedKey: null, suggestedScope: null,
    safeguard: false, sensitive, upload: false, status: "open", answer: null, draft: null
  });
  const pauseDecision = (fieldId: string): FillDecision => ({ fieldId, action: "pause", value: null, basis: null, reason: "Paused.", pause: { question: "?", key: null, scope: null, safeguard: false } });
  const posting = { id: "00000000-0000-4000-8000-000000000001", companyName: "Aurora Labs", title: "Intern", snapshot: { normalizedText: "Aurora builds tools." } } as unknown as JobPosting;

  it("fills drafted answers, pauses blank with the best draft, and leaves other pauses alone", async () => {
    const decisions: FillDecision[] = [
      pauseDecision("why"), pauseDecision("eeo"), pauseDecision("badge"),
      { fieldId: "exp", action: "fill", value: "Template answer.", basis: { kind: "package-answer", prompt: "Describe your most relevant experience." }, reason: "Package.", pause: null }
    ];
    const pauses = [pause("why", form.fields[0]!.label), pause("eeo", "Gender identity", true), pause("badge", form.fields[2]!.label)];
    const asked: string[] = [];
    const result = await applyVoiceDrafts({ decisions, pauses }, form, {
      posting, sources: [],
      drafter: async ({ question }) => {
        asked.push(question);
        return question.startsWith("Why")
          ? { status: "filled", text: "Drafted answer.", gate: { passed: true, averagePercentile: 40, targetAverage: 65, detectors: {}, revisions: 1 } }
          : { status: "blank", draft: { text: "Best try.", gate: null, reason: "Did not pass." } };
      }
    });
    expect(asked).toEqual(["Why do you want to work at Aurora Labs?", "Describe your most relevant experience."]);
    expect(result.decisions.find((entry) => entry.fieldId === "why")).toMatchObject({ action: "fill", value: "Drafted answer.", basis: { kind: "voice_draft" } });
    expect(result.decisions.find((entry) => entry.fieldId === "exp")).toMatchObject({ action: "pause", value: null });
    expect(result.pauses.map((entry) => entry.fieldId).sort()).toEqual(["badge", "eeo", "exp"]);
    expect(result.pauses.find((entry) => entry.fieldId === "exp")?.draft).toEqual({ text: "Best try.", gate: null, reason: "Did not pass." });
    expect(result.pauses.find((entry) => entry.fieldId === "eeo")?.draft).toBeNull();
  });
});
