import { describe, expect, it } from "vitest";

import { aiReviewMatchLabel, aiReviewMatchReason, atsConfirmationCaptured, autoSubmitBlockers, hasApplicationContent, isAiReviewMatchReason, isPossibleSubmissionNote, autoSubmitSettings, manualOnly, NO_APPLICATION_CONTENT_BLOCKER, POSSIBLE_SUBMISSION_NOTE, SITE_VALUE_KEPT_REASON, uncapturedSiteRun, UNCONFIRMED_SITE_VALUE_REASON } from "@internship-agent/domain";

/** Track 80: the candidate's name and email from the profile, the application content an unconfirmed run needs. */
const NAME_AND_EMAIL = [
  { action: "fill", basis: { kind: "profile", field: "fullName" } },
  { action: "fill", basis: { kind: "profile", field: "email" } }
];

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
    expect(autoSubmitBlockers({ ...clean, atsConfirmed: false, decisions: [...clean.decisions, ...NAME_AND_EMAIL] })).toEqual([]);
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

  it("holds only SmartRecruiters for its site type (Track 80)", () => {
    const clean = { status: "awaiting-approval", atsConfirmed: false, pauses: [], decisions: [{ action: "fill", basis: { kind: "fact" } }, ...NAME_AND_EMAIL] };
    expect(autoSubmitBlockers({ ...clean, suggestedAtsKind: "oracle" })).toEqual([]);
    expect(autoSubmitBlockers({ ...clean, suggestedAtsKind: "smartrecruiters" })[0]).toMatch(/^SmartRecruiters application sites are recognized/);
    expect(autoSubmitBlockers({ ...clean, suggestedAtsKind: null })).toEqual([]);
    expect(autoSubmitBlockers({ ...clean, suggestedAtsKind: "lever" })).toEqual([]);
    expect(autoSubmitBlockers({ ...clean, atsConfirmed: true, atsKind: "smartrecruiters" })[0]).toMatch(/^SmartRecruiters application sites are recognized/);
  });

  it("keeps every kind but SmartRecruiters clean (Track 80)", () => {
    const filled = { status: "awaiting-approval", pauses: [], decisions: [{ action: "fill", basis: { kind: "fact" } }, ...NAME_AND_EMAIL] };
    // A supported adapter (Greenhouse, Lever, Ashby, Dover) confirms its kind itself: nothing holds the run.
    expect(autoSubmitBlockers({ ...filled, atsConfirmed: true, suggestedAtsKind: null })).toEqual([]);
    // Paylocity is recognized without an adapter; its runs are submitted under the extra checks uncapturedSiteRun names.
    expect(autoSubmitBlockers({ ...filled, atsConfirmed: false, suggestedAtsKind: "paylocity" })).toEqual([]);
    // A site reached only by the generic navigation is not recognized, and it is no longer held for it.
    expect(autoSubmitBlockers({ ...filled, atsConfirmed: false, suggestedAtsKind: null })).toEqual([]);
  });

  it("holds a run without application content on a site without a captured flow (Track 80)", () => {
    const emailOnly = [{ action: "fill", basis: { kind: "profile", field: "email" } }];
    const run = { status: "awaiting-approval", atsConfirmed: false, pauses: [], decisions: emailOnly };
    // Track 77 found unknown sites whose only captured field was a newsletter email box.
    expect(autoSubmitBlockers(run)).toEqual([NO_APPLICATION_CONTENT_BLOCKER]);
    expect(autoSubmitBlockers({ ...run, atsConfirmed: true, atsKind: "oracle" })).toEqual([NO_APPLICATION_CONTENT_BLOCKER]);
    expect(autoSubmitBlockers({ ...run, atsConfirmed: true, atsKind: "unknown" })).toEqual([NO_APPLICATION_CONTENT_BLOCKER]);
    // A kind whose flow was captured, and a confirmed run object without a kind, are unchanged.
    expect(autoSubmitBlockers({ ...run, atsConfirmed: true, atsKind: "greenhouse" })).toEqual([]);
    expect(autoSubmitBlockers({ ...run, atsConfirmed: true })).toEqual([]);
    // The candidate's name with the email, or an uploaded resume or document, is application content.
    expect(autoSubmitBlockers({ ...run, decisions: NAME_AND_EMAIL })).toEqual([]);
    const legalFirst = [{ action: "fill", basis: { kind: "profile", field: "legalFirstName" } }, ...emailOnly];
    expect(autoSubmitBlockers({ ...run, decisions: legalFirst })).toEqual([]);
    const nameOnly = [{ action: "fill", basis: { kind: "profile", field: "fullName" } }];
    expect(autoSubmitBlockers({ ...run, decisions: nameOnly })).toEqual([NO_APPLICATION_CONTENT_BLOCKER]);
    const emailAndPhone = [...emailOnly, { action: "fill", basis: { kind: "profile", field: "phone" } }];
    expect(autoSubmitBlockers({ ...run, decisions: emailAndPhone })).toEqual([NO_APPLICATION_CONTENT_BLOCKER]);
    const variant = { action: "upload", basis: { kind: "variant", variantId: "00000000-0000-4000-8000-000000000001" } };
    const baseResume = { action: "upload", basis: { kind: "base_resume", baseResumeId: "00000000-0000-4000-8000-000000000002" } };
    const transcript = { action: "upload", basis: { kind: "candidate_document", documentId: "00000000-0000-4000-8000-000000000003" } };
    expect(autoSubmitBlockers({ ...run, decisions: [variant] })).toEqual([]);
    expect(autoSubmitBlockers({ ...run, decisions: [baseResume, ...emailOnly] })).toEqual([]);
    expect(autoSubmitBlockers({ ...run, decisions: [transcript] })).toEqual([]);
    // A skipped or paused document field, or a suggested name, is not content.
    const skipped = { action: "skip", basis: { kind: "variant", variantId: "00000000-0000-4000-8000-000000000001" } };
    const paused = { action: "pause", basis: { kind: "base_resume", baseResumeId: "00000000-0000-4000-8000-000000000002" } };
    expect(autoSubmitBlockers({ ...run, decisions: [skipped, paused, ...emailOnly] })).toEqual([NO_APPLICATION_CONTENT_BLOCKER]);
    const suggested = [{ action: "suggest", basis: { kind: "profile", field: "fullName" } }, ...emailOnly];
    expect(autoSubmitBlockers({ ...run, decisions: suggested })).toEqual([NO_APPLICATION_CONTENT_BLOCKER]);
    // A several-page form walked step by step is guarded even on a confirmed captured kind.
    const stepped = [{ fieldId: "step-1::email", action: "fill", basis: { kind: "profile", field: "email" } }];
    expect(autoSubmitBlockers({ ...run, atsConfirmed: true, atsKind: "greenhouse", decisions: stepped })).toEqual([NO_APPLICATION_CONTENT_BLOCKER]);
    // The reason comes after the other blockers, so a held run still names them.
    expect(autoSubmitBlockers({ ...run, pauses: [{ safeguard: true, status: "open" }] })).toEqual([
      "The site showed a safeguard challenge.",
      "The form has unanswered questions waiting for you.",
      NO_APPLICATION_CONTENT_BLOCKER
    ]);
  });

  it("reads application content from a run's own decisions (Track 80)", () => {
    const email = { action: "fill", basis: { kind: "profile", field: "email" } };
    expect(hasApplicationContent([])).toBe(false);
    expect(hasApplicationContent([email])).toBe(false);
    expect(hasApplicationContent([{ action: "fill", basis: { kind: "fact" } }, email])).toBe(false);
    expect(hasApplicationContent(NAME_AND_EMAIL)).toBe(true);
    for (const field of ["fullName", "legalFirstName", "legalLastName", "preferredName"]) {
      expect(hasApplicationContent([{ action: "fill", basis: { kind: "profile", field } }, email])).toBe(true);
      expect(hasApplicationContent([{ action: "choose", basis: { kind: "profile", field } }, email])).toBe(true);
      expect(hasApplicationContent([{ action: "check", basis: { kind: "profile", field } }, email])).toBe(true);
      expect(hasApplicationContent([{ action: "suggest", basis: { kind: "profile", field } }, email])).toBe(false);
      expect(hasApplicationContent([{ action: "fill", basis: { kind: "profile", field } }])).toBe(false);
    }
    expect(hasApplicationContent([{ action: "fill", basis: { kind: "profile", field: "phone" } }, email])).toBe(false);
    expect(hasApplicationContent([{ action: "upload", basis: { kind: "profile", field: "fullName" } }, email])).toBe(false);
    const variant = { action: "upload", basis: { kind: "variant", variantId: "00000000-0000-4000-8000-000000000001" } };
    const baseResume = { action: "upload", basis: { kind: "base_resume", baseResumeId: "00000000-0000-4000-8000-000000000002" } };
    const transcript = { action: "upload", basis: { kind: "candidate_document", documentId: "00000000-0000-4000-8000-000000000003" } };
    expect(hasApplicationContent([variant])).toBe(true);
    expect(hasApplicationContent([baseResume])).toBe(true);
    expect(hasApplicationContent([transcript])).toBe(true);
    expect(hasApplicationContent([{ action: "upload", basis: null }])).toBe(false);
    expect(hasApplicationContent([{ ...variant, action: "skip" }, { ...baseResume, action: "pause" }, { ...transcript, action: "keep" }])).toBe(false);
  });

  it("names the kinds whose confirmation page was captured, and the runs on any other site (Track 80)", () => {
    // Track 85: Workable joins on the success text from its public bundle that the fixture regression reads.
    for (const kind of ["greenhouse", "lever", "workday", "handshake", "ashby", "dover", "workable"]) expect(atsConfirmationCaptured(kind)).toBe(true);
    for (const kind of ["oracle", "paylocity", "unknown", null]) expect(atsConfirmationCaptured(kind)).toBe(false);
    expect(uncapturedSiteRun({ atsKind: "greenhouse", decisions: [{ fieldId: "email" }] })).toBe(false);
    expect(uncapturedSiteRun({ atsKind: "oracle", decisions: [{ fieldId: "email" }] })).toBe(true);
    expect(uncapturedSiteRun({ atsKind: "unknown", decisions: [{ fieldId: "email" }] })).toBe(true);
    expect(uncapturedSiteRun({ atsKind: "paylocity", decisions: [] })).toBe(true);
    expect(uncapturedSiteRun({ atsKind: "greenhouse", decisions: [{ fieldId: "step-1::email" }] })).toBe(true);
    expect(uncapturedSiteRun({ atsKind: "workable", decisions: [] })).toBe(false);
  });

  it("reads a policy submit held as a possible submission from its note, in either form (Track 85)", () => {
    expect(isPossibleSubmissionNote(`${POSSIBLE_SUBMISSION_NOTE}The auto-submit policy clicked the final submit of the application at x.example.`)).toBe(true);
    expect(isPossibleSubmissionNote("Automatic submission failed: The auto-submit policy clicked the final submit of the application at x.example and the page read as a confirmation.")).toBe(true);
    expect(isPossibleSubmissionNote("Automatic submission failed: The site did not load.")).toBe(false);
    expect(isPossibleSubmissionNote(null)).toBe(false);
    expect(isPossibleSubmissionNote(undefined)).toBe(false);
  });
});
