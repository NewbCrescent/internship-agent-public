import { describe, expect, it } from "vitest";

import { aiReviewMatchLabel, aiReviewMatchReason, autoSubmitBlockers, isAiReviewMatchReason, autoSubmitSettings, manualOnly, SITE_VALUE_KEPT_REASON, UNCONFIRMED_SITE_VALUE_REASON } from "@internship-agent/domain";

describe("manual checklist mode", () => {
  it("leaves AI submission visible unless explicitly enabled", () => {
    expect(manualOnly({})).toBe(false);
    expect(manualOnly({ INTERNSHIP_AGENT_MANUAL_ONLY: "" })).toBe(false);
    expect(manualOnly({ INTERNSHIP_AGENT_MANUAL_ONLY: "0" })).toBe(false);
    expect(manualOnly({ INTERNSHIP_AGENT_MANUAL_ONLY: "yes" })).toBe(false);
  });
  it("hides AI submission on an explicit 1", () => {
    expect(manualOnly({ INTERNSHIP_AGENT_MANUAL_ONLY: "1" })).toBe(true);
    expect(manualOnly({ INTERNSHIP_AGENT_MANUAL_ONLY: " 1 " })).toBe(true);
  });
});

describe("auto-submit policy", () => {
  const on = { INTERNSHIP_AGENT_AUTO_SUBMIT: "1", INTERNSHIP_AGENT_AUTO_APPLY: "1" };
  it("is off unless auto-submit and auto-apply are both on, and manual mode always wins", () => {
    expect(autoSubmitSettings({})).toBeNull();
    expect(autoSubmitSettings({ INTERNSHIP_AGENT_AUTO_SUBMIT: "1" })).toBeNull();
    expect(autoSubmitSettings({ ...on, INTERNSHIP_AGENT_MANUAL_ONLY: "1" })).toBeNull();
    expect(autoSubmitSettings(on)).toEqual({ minFit: 50, dailyCap: 10 });
    expect(autoSubmitSettings({ ...on, INTERNSHIP_AGENT_AUTO_SUBMIT_MIN_FIT: "40", INTERNSHIP_AGENT_AUTO_SUBMIT_DAILY_CAP: "500" }))
      .toEqual({ minFit: 40, dailyCap: 50 });
    expect(autoSubmitSettings({ ...on, INTERNSHIP_AGENT_AUTO_SUBMIT_MIN_FIT: "x", INTERNSHIP_AGENT_AUTO_SUBMIT_DAILY_CAP: "0" }))
      .toEqual({ minFit: 50, dailyCap: 1 });
    expect(autoSubmitSettings({ ...on, INTERNSHIP_AGENT_AUTO_SUBMIT_MIN_FIT: "30" })?.minFit).toBe(40);
    expect(autoSubmitSettings({ ...on, INTERNSHIP_AGENT_AUTO_SUBMIT_MIN_FIT: "120" })?.minFit).toBe(100);
  });

  it("removes the daily cap for the exact unlimited setting, subject to manual mode", () => {
    const unlimited = { ...on, INTERNSHIP_AGENT_AUTO_SUBMIT_DAILY_CAP: "  unlimited  " };
    expect(autoSubmitSettings(unlimited)).toEqual({ minFit: 50, dailyCap: null });
    expect(autoSubmitSettings({ ...unlimited, INTERNSHIP_AGENT_MANUAL_ONLY: "1" })).toBeNull();
    expect(autoSubmitSettings({ ...on, INTERNSHIP_AGENT_AUTO_SUBMIT_DAILY_CAP: "7" })?.dailyCap).toBe(7);
    expect(autoSubmitSettings({ ...on, INTERNSHIP_AGENT_AUTO_SUBMIT_DAILY_CAP: " " })?.dailyCap).toBe(10);
    expect(autoSubmitSettings({ ...on, INTERNSHIP_AGENT_AUTO_SUBMIT_DAILY_CAP: "Unlimited" })?.dailyCap).toBe(10);
  });

  it("names every reason a filled run stays with the candidate", () => {
    const clean = { status: "awaiting-approval", atsConfirmed: true, pauses: [], decisions: [{ action: "fill", basis: { kind: "fact" } }] };
    expect(autoSubmitBlockers(clean)).toEqual([]);
    expect(autoSubmitBlockers({ ...clean, status: "paused-needs-input" })).toHaveLength(1);
    expect(autoSubmitBlockers({ ...clean, pauses: [{ safeguard: false, status: "answered" }] })).toEqual([]);
    expect(autoSubmitBlockers({ ...clean, pauses: [{ safeguard: false, status: "open" }] })).toEqual([
      "The form has unanswered questions waiting for you."
    ]);
    expect(autoSubmitBlockers({ ...clean, pauses: [{ safeguard: true, status: "open" }] })).toEqual([
      "The site showed a safeguard challenge.",
      "The form has unanswered questions waiting for you."
    ]);
    expect(autoSubmitBlockers({ ...clean, pauses: [{ safeguard: true, status: "answered" }] })).toEqual([
      "The site showed a safeguard challenge."
    ]);
    expect(autoSubmitBlockers({ ...clean, atsConfirmed: false })).toEqual(["The application site type was not recognized automatically."]);
    expect(autoSubmitBlockers({ ...clean, decisions: [{ action: "fill", basis: { kind: "voice_draft" } }] })).toHaveLength(1);
    expect(autoSubmitBlockers({ ...clean, decisions: [{ action: "keep", basis: null }] })).toHaveLength(1);
  });

  it("lets a guard-checked AI review match auto-submit and holds a suggested draft only while unanswered (Track 45)", () => {
    const clean = { status: "awaiting-approval", atsConfirmed: true, pauses: [], decisions: [{ action: "fill", basis: { kind: "fact" } }] };
    // The candidate's decision (2026-11-26): an answer the AI review matched after every guardrail passed does not hold the run.
    expect(autoSubmitBlockers({ ...clean, decisions: [{ action: "choose", basis: { kind: "fact" }, reason: aiReviewMatchReason("Studying full time?") }] })).toEqual([]);
    expect(autoSubmitBlockers({ ...clean, pauses: [{ safeguard: false, status: "open", draft: { source: "pause_review" } }] })).toContain(
      "AI review suggested a draft; you review those."
    );
    // Answered by the candidate (with the draft or their own text), it is the candidate's answer.
    expect(autoSubmitBlockers({ ...clean, pauses: [{ safeguard: false, status: "answered", draft: { source: "pause_review" } }] })).toEqual([]);
    // A voice draft and older drafts without a source do not count as AI review suggestions.
    expect(autoSubmitBlockers({ ...clean, pauses: [{ safeguard: false, status: "answered", draft: { source: "voice" } }] })).toEqual([]);
    expect(autoSubmitBlockers({ ...clean, pauses: [{ safeguard: false, status: "answered", draft: {} }, { safeguard: false, status: "answered", draft: null }] })).toEqual([]);
  });

  it("names the question in an AI review match reason, and reads it back", () => {
    const reason = aiReviewMatchReason("  Studying   on a \"full\" schedule?\n");
    expect(reason).toBe(`AI review matched "Studying on a 'full' schedule?" to your saved answer.`);
    expect(isAiReviewMatchReason(reason)).toBe(true);
    expect(aiReviewMatchLabel(reason)).toBe("Studying on a 'full' schedule?");
    expect(aiReviewMatchLabel(aiReviewMatchReason("x".repeat(400)))).toHaveLength(150);
    expect(isAiReviewMatchReason("The site already shows this value.")).toBe(false);
    expect(isAiReviewMatchReason(undefined)).toBe(false);
  });

  it("holds only kept attachments and unconfirmed shown answers", () => {
    const clean = { status: "awaiting-approval", atsConfirmed: true, pauses: [], decisions: [{ action: "fill", basis: { kind: "fact" } }] };
    const keep = (reason?: string) => ({ ...clean, decisions: [...clean.decisions, { action: "keep", basis: null, ...(reason === undefined ? {} : { reason }) }] });
    const unconfirmed = "The site already shows an answer that none of your saved answers confirms; you review those.";
    // A value a Workday field already showed (its default Country, the Country Phone Code chip) with nothing saved against it.
    expect(autoSubmitBlockers(keep(SITE_VALUE_KEPT_REASON))).toEqual([]);
    expect(autoSubmitBlockers(keep(UNCONFIRMED_SITE_VALUE_REASON))).toEqual([unconfirmed]);
    // Runs planned before 2026-11-25 recorded every shown value this way; they stay held.
    expect(autoSubmitBlockers(keep("The site already shows this value."))).toEqual([unconfirmed]);
    expect(autoSubmitBlockers(keep('Keeps the resume Handshake attached from your Handshake account ("r.pdf") once you confirm it is current.')))
      .toEqual(["The site kept an attachment you need to confirm."]);
    expect(autoSubmitBlockers(keep())).toEqual(["The site kept an attachment you need to confirm."]);
    expect(autoSubmitBlockers({ ...keep(SITE_VALUE_KEPT_REASON), pauses: [{ safeguard: false, status: "open" }] })).toEqual([
      "The form has unanswered questions waiting for you."
    ]);
  });

  it("says when a recognized site has no adapter and the candidate approves each run", () => {
    const clean = { status: "awaiting-approval", atsConfirmed: false, pauses: [], decisions: [{ action: "fill", basis: { kind: "fact" } }] };
    expect(autoSubmitBlockers({ ...clean, suggestedAtsKind: "oracle" })).toEqual([
      "Oracle Cloud HCM application sites are recognized, but the agent has no adapter that walks their application, so you approve each one."
    ]);
    expect(autoSubmitBlockers({ ...clean, suggestedAtsKind: "smartrecruiters" })[0]).toMatch(/^SmartRecruiters application sites are recognized/);
    expect(autoSubmitBlockers({ ...clean, suggestedAtsKind: null })).toEqual(["The application site type was not recognized automatically."]);
    expect(autoSubmitBlockers({ ...clean, suggestedAtsKind: "lever" })).toEqual(["The application site type was not recognized automatically."]);
  });

  it("keeps supported kinds clean and holds unsupported or unknown ones", () => {
    const filled = { status: "awaiting-approval", pauses: [], decisions: [{ action: "fill", basis: { kind: "fact" } }] };
    // A supported adapter (Greenhouse, Lever, Ashby, Dover) confirms its kind itself: nothing holds the run.
    expect(autoSubmitBlockers({ ...filled, atsConfirmed: true, suggestedAtsKind: null })).toEqual([]);
    // Paylocity is recognized but its five-step form has no adapter yet.
    expect(autoSubmitBlockers({ ...filled, atsConfirmed: false, suggestedAtsKind: "paylocity" })).toEqual([
      "Paylocity application sites are recognized, but the agent has no adapter that walks their application, so you approve each one."
    ]);
    // A site reached only by the generic navigation is not recognized, so it is not supported.
    expect(autoSubmitBlockers({ ...filled, atsConfirmed: false, suggestedAtsKind: null })).toEqual(["The application site type was not recognized automatically."]);
  });
});
