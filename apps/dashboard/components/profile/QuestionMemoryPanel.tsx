"use client";

import { useActionState } from "react";

import type { FactScope, MappedQuestion, QuestionResolution } from "@internship-agent/domain";

import {
  answerQuestionAction,
  resolveQuestionAction
} from "@/app/profile/actions";
import { initialMemoryActionState } from "@/app/profile/action-state";

export function QuestionMemoryPanel() {
  const [lookupState, lookupAction, lookupPending] = useActionState(resolveQuestionAction, initialMemoryActionState);
  const resolution = lookupState.resolution;

  return (
    <section className="panel">
      <div className="section-heading">
        <div><h2>Ask candidate memory</h2></div>
        <span className="pill">Offline</span>
      </div>
      <form action={lookupAction} className="question-form">
        <label className="field question-field"><span>Application question</span><textarea name="question" rows={3} required placeholder="Would you consider relocating to Seattle?" /></label>
        <div className="context-row">
          <label className="field"><span>Location context <small>optional</small></span><input name="location" placeholder="Seattle, WA" /></label>
          <label className="field"><span>Country code <small>optional</small></span><input name="countryCode" placeholder="US" maxLength={3} /></label>
          <label className="field"><span>Applies to</span><select name="applicationChannel" defaultValue=""><option value="">All applications</option><option value="handshake_internal">2029 profile (Handshake Quick Apply / Apply, or transcript required)</option></select></label>
          <button className="primary-button align-end" disabled={lookupPending} type="submit">{lookupPending ? "Checking…" : "Check memory"}</button>
        </div>
      </form>
      {lookupState.error ? <p className="result-card error" role="alert">{lookupState.error}</p> : null}
      {resolution ? <ResolutionCard resolution={resolution} /> : null}
    </section>
  );
}

function ResolutionCard({ resolution }: { resolution: QuestionResolution }) {
  if (resolution.status === "RESOLVED") {
    // A Handshake-only question answered by the general fact can still get
    // its own Handshake answer.
    const fellBackToGlobal = resolution.mapping.scope.kind === "application_channel" && resolution.fact.scope.kind === "global";
    return (
      <>
      <div className="result-card success" data-testid="memory-resolution">
        <span className="result-label">Answered from memory</span>
        <strong>{resolution.displayAnswer}</strong>
        <p>{resolution.mapping.explanation}</p>
        <dl className="provenance-list">
          <div><dt>Fact key</dt><dd>{resolution.fact.key}</dd></div>
          <div><dt>Source</dt><dd>{resolution.fact.source}</dd></div>
          <div><dt>Remembered</dt><dd>{resolution.fact.rememberedAt ? formatTimestamp(resolution.fact.rememberedAt) : "Profile fact"}</dd></div>
          <div><dt>Scope</dt><dd>{fellBackToGlobal ? "All applications (no 2029-profile answer yet)" : scopeText(resolution.fact.scope)}</dd></div>
        </dl>
      </div>
      {fellBackToGlobal ? (
        <AnswerForm
          question={resolution.question}
          mapping={resolution.mapping}
          heading="Set a 2029-profile answer"
          reason="Handshake Quick Apply / Apply applications and applications asking for a transcript will use this instead of the general answer. Other applications keep the general answer."
        />
      ) : null}
      </>
    );
  }
  if (resolution.status === "NEEDS_INPUT") {
    return <AnswerForm question={resolution.question} mapping={resolution.mapping} heading="No compatible fact found" reason={resolution.reason} />;
  }
  if (resolution.status === "ANSWERED_ONCE") {
    return <div className="result-card"><span className="result-label">Answered once</span><strong>{resolution.displayAnswer}</strong><p>{resolution.reason}</p></div>;
  }
  return (
    <div className="result-card warning" data-testid="memory-boundary">
      <span className="result-label">Candidate input required</span>
      <strong>{resolution.status.replaceAll("_", " ").toLocaleLowerCase("en-US")}</strong>
      <p>{resolution.reason}</p>
    </div>
  );
}

function AnswerForm({ question, mapping, heading, reason }: {
  question: string;
  mapping: MappedQuestion;
  heading: string;
  reason: string;
}) {
  const [state, action, pending] = useActionState(answerQuestionAction, initialMemoryActionState);
  if (state.resolution && state.resolution.status !== "NEEDS_INPUT") return <ResolutionCard resolution={state.resolution} />;
  return (
    <div className="result-card needs-input" data-testid="needs-input">
      <span className="result-label">{heading}</span>
      <strong>{reason}</strong>
      <form action={action} className="answer-form">
        <input type="hidden" name="question" value={question} />
        {mapping.scope.kind === "location" ? <input type="hidden" name="location" value={mapping.scope.name} /> : null}
        {mapping.scope.kind === "country" ? <input type="hidden" name="countryCode" value={mapping.scope.code} /> : null}
        {mapping.scope.kind === "application_channel" ? <input type="hidden" name="applicationChannel" value={mapping.scope.channel} /> : null}
        <label className="field"><span>Your answer</span><input name="answer" required placeholder={mapping.key.includes("date") ? "YYYY-MM-DD" : "Yes or no"} /></label>
        <label className="remember-check"><input type="checkbox" name="remember" defaultChecked /> Remember for this exact scope</label>
        <button className="primary-button" disabled={pending} type="submit">{pending ? "Saving…" : "Use answer"}</button>
      </form>
      {state.error ? <p className="form-message error" role="alert">{state.error}</p> : null}
    </div>
  );
}

function scopeText(scope: FactScope): string {
  if (scope.kind === "global") return "All applications";
  if (scope.kind === "country") return scope.code;
  if (scope.kind === "application_channel") return "2029 profile: Handshake Quick Apply / Apply, or applications asking for a transcript";
  return scope.name;
}

function formatTimestamp(value: string): string {
  return `${value.slice(0, 16).replace("T", " ")} UTC`;
}
