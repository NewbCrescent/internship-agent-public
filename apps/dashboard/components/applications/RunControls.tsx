"use client";

import { useActionState } from "react";

import { initialApplicationActionState } from "@/app/applications/action-state";
import {
  answerPauseAction,
  approveSubmissionAction,
  cancelRunAction,
  confirmAtsAction,
  continueRunAction,
  startBrowserRunAction,
  submitRunAction
} from "@/app/applications/actions";

export function StartRunForm({ jobId, defaultUrl, manualOnly }: { jobId: string; defaultUrl: string; manualOnly?: boolean }) {
  const [state, action, pending] = useActionState(startBrowserRunAction, initialApplicationActionState);
  if (manualOnly) return null;
  return (
    <form action={action} className="run-form">
      <input type="hidden" name="jobId" value={jobId} />
      <label className="field">
        <span>Handshake application URL</span>
        <input name="applicationUrl" defaultValue={defaultUrl} required />
      </label>
      <button className="primary-button" type="submit" disabled={pending}>{pending ? "Starting…" : "Start browser run"}</button>
      <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
    </form>
  );
}

export function PauseAnswerForm({ runId, fieldId, question, sensitive, written = false, manualOnly }: {
  runId: string; fieldId: string; question: string; sensitive: boolean;
  /** An open-ended answer the candidate writes; it is used for this application only. */
  written?: boolean;
  manualOnly?: boolean;
}) {
  const [state, action, pending] = useActionState(answerPauseAction, initialApplicationActionState);
  if (manualOnly) return null;
  return (
    <form action={action} className="pause-form">
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="fieldId" value={fieldId} />
      <p><strong>Paused:</strong> {question}</p>
      <label className="field">
        <span>Your answer</span>
        {written ? <textarea name="answer" required rows={8} /> : <input name="answer" required />}
      </label>
      {written ? (
        <p className="unknown-note">Used for this application only; not remembered.</p>
      ) : sensitive ? (
        <p className="unknown-note">Sensitive: used for this run only, never stored.</p>
      ) : (
        <label className="remember-check">
          <input type="checkbox" name="remember" defaultChecked /> Remember for this exact scope
        </label>
      )}
      <button className="primary-button" type="submit" disabled={pending}>{pending ? "Recording…" : "Record answer"}</button>
      <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
    </form>
  );
}

export function ConfirmAtsForm({ runId, suggested, confidence, manualOnly }: { runId: string; suggested: string | null; confidence: number; manualOnly?: boolean }) {
  const [state, action, pending] = useActionState(confirmAtsAction, initialApplicationActionState);
  if (manualOnly) return null;
  return (
    <form action={action} className="ats-form">
      <input type="hidden" name="runId" value={runId} />
      <p>
        {suggested
          ? <>Looks like <strong>{suggested}</strong> ({Math.round(confidence * 100)}% confidence).</>
          : <>No ATS recognized ({Math.round(confidence * 100)}% confidence).</>}
      </p>
      <div className="filter-row">
        {suggested ? <button className="primary-button" type="submit" name="kind" value={suggested} disabled={pending}>Proceed as {suggested}</button> : null}
        <button type="submit" name="kind" value="unknown" disabled={pending}>Proceed generic</button>
      </div>
      <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
    </form>
  );
}

function RunStepButton({ runId, action, label, pendingLabel, confirmText, className }: {
  runId: string;
  action: typeof continueRunAction;
  label: string;
  pendingLabel: string;
  confirmText?: string;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialApplicationActionState);
  return (
    <form
      action={formAction}
      onSubmit={confirmText ? (event) => {
        if (!window.confirm(confirmText)) event.preventDefault();
      } : undefined}
    >
      <input type="hidden" name="runId" value={runId} />
      <button className={className} type="submit" disabled={pending}>{pending ? pendingLabel : label}</button>
      <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
    </form>
  );
}

export function ContinueRunButton({ runId, manualOnly }: { runId: string; manualOnly?: boolean }) {
  if (manualOnly) return null;
  return <RunStepButton runId={runId} action={continueRunAction} label="Continue run" pendingLabel="Continuing…" className="primary-button" />;
}

export function ApproveSubmissionButton({ runId, manualOnly }: { runId: string; manualOnly?: boolean }) {
  if (manualOnly) return null;
  return (
    <RunStepButton
      runId={runId}
      action={approveSubmissionAction}
      label="Approve submission"
      pendingLabel="Approving…"
      className="primary-button"
      confirmText="Approve submitting this application in your browser session? This is the final human approval."
    />
  );
}

export function SubmitRunButton({ runId, manualOnly }: { runId: string; manualOnly?: boolean }) {
  if (manualOnly) return null;
  return (
    <RunStepButton
      runId={runId}
      action={submitRunAction}
      label="Submit now"
      pendingLabel="Submitting…"
      className="primary-button"
      confirmText="Submit this application now? The run records exactly what was sent."
    />
  );
}

export function CancelRunButton({ runId }: { runId: string }) {
  return <RunStepButton runId={runId} action={cancelRunAction} label="Cancel run" pendingLabel="Cancelling…" />;
}
