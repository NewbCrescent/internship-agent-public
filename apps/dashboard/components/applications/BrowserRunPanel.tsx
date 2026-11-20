import type { BrowserRun } from "@internship-agent/domain";

import {
  ApproveSubmissionButton,
  CancelRunButton,
  ConfirmAtsForm,
  ContinueRunButton,
  PauseAnswerForm,
  StartRunForm,
  SubmitRunButton
} from "./RunControls";

const RUNNABLE = new Set(["APPROVED", "APPLYING"]);

export function BrowserRunPanel({
  jobId,
  status,
  defaultUrl,
  runs,
  canStart,
  manualOnly
}: {
  jobId: string;
  status: string;
  defaultUrl: string;
  runs: BrowserRun[];
  /** Whether a new run may start now (approved, or retrying after a failed or cancelled run). */
  canStart: boolean;
  manualOnly?: boolean;
}) {
  if (!RUNNABLE.has(status) && runs.length === 0) return null;
  return (
    <section className="panel" aria-label="Handshake browser runs">
      <div className="section-heading">
        <div><h2>Browser runs</h2></div>
      </div>
      {canStart ? <StartRunForm jobId={jobId} defaultUrl={defaultUrl} manualOnly={manualOnly} /> : null}
      {runs.length === 0 ? (
        <p className="form-help">No runs yet. Starting opens your browser session at the application URL.</p>
      ) : runs.map((run) => {
        const openPauses = run.pauses.filter((pause) => pause.status === "open");
        return (
          <article key={run.id} className="run-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">{new Date(run.updatedAt).toLocaleString("en-US")}</p>
                <h3>{run.status.replace(/-/g, " ")}</h3>
              </div>
              <span className="pill">{run.decisions.filter((d) => d.action !== "pause" && d.action !== "skip" && d.action !== "keep" && d.action !== "remove").length} filled</span>
            </div>
            <p className="unknown-note">
              ATS: {run.atsKind}{run.suggestedAtsKind ? ` (suggested ${run.suggestedAtsKind}, awaiting confirmation)` : ""}
            </p>
            {!run.atsConfirmed ? (
              <ConfirmAtsForm runId={run.id} suggested={run.suggestedAtsKind} confidence={run.atsConfidence} manualOnly={manualOnly} />
            ) : null}
            <ul className="reason-list" aria-label="Fill decisions">
              {run.decisions.map((decision) => (
                <li key={decision.fieldId}>
                  <strong>{decision.fieldId}</strong> · {decision.action}
                  {decision.basis?.kind === "voice_draft" ? " (drafted in your voice)" : ""}
                  {decision.value && decision.basis?.kind !== "voice_draft" ? `: ${decision.value.slice(0, 120)}` : ""} — {decision.reason}
                  {decision.basis?.kind === "voice_draft" && decision.value ? <blockquote className="draft-text">{decision.value}</blockquote> : null}
                </li>
              ))}
            </ul>
            {openPauses.map((pause) => (
              <div key={pause.fieldId}>
                {pause.draft ? (
                  <div className="draft-reference">
                    <p className="unknown-note">
                      {pause.draft.reason}
                      {pause.draft.gate ? ` Best draft: average ${pause.draft.gate.averagePercentile.toFixed(1)}% vs target ${pause.draft.gate.targetAverage.toFixed(0)}% (${Object.entries(pause.draft.gate.detectors).map(([name, result]) => `${name} ${result.passed ? "pass" : "fail"}`).join(", ")}).` : ""}
                    </p>
                    {pause.draft.text ? <blockquote className="draft-text">{pause.draft.text}</blockquote> : null}
                  </div>
                ) : null}
                <PauseAnswerForm runId={run.id} fieldId={pause.fieldId} question={pause.question} sensitive={pause.sensitive} written={pause.draft !== null} manualOnly={manualOnly} />
              </div>
            ))}
            {run.status === "paused-needs-input" && openPauses.length === 0 ? <ContinueRunButton runId={run.id} manualOnly={manualOnly} /> : null}
            {run.status === "awaiting-approval" && !run.submissionApprovedAt ? (
              <ApproveSubmissionButton runId={run.id} manualOnly={manualOnly} />
            ) : null}
            {run.status === "awaiting-approval" && run.submissionApprovedAt ? (
              <SubmitRunButton runId={run.id} manualOnly={manualOnly} />
            ) : null}
            {run.status !== "submitted" && run.status !== "cancelled" ? <CancelRunButton runId={run.id} /> : null}
            {run.confirmationText ? (
              <p className="unknown-note">Confirmation: {run.confirmationText.slice(0, 300)}</p>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
