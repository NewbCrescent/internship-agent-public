"use client";

import { useActionState } from "react";

import { initialApplicationActionState } from "@/app/applications/action-state";
import { recordOutcomeAction } from "@/app/applications/actions";

const OUTCOMES = [
  { value: "RESPONSE", label: "Response" },
  { value: "OA", label: "Online assessment" },
  { value: "SCREEN", label: "Recruiter screen" },
  { value: "INTERVIEW", label: "Interview" },
  { value: "FINAL", label: "Final round" },
  { value: "OFFER", label: "Offer" },
  { value: "REJECTED", label: "Rejected" },
  { value: "GHOSTED", label: "No response / ghosted" }
];

/**
 * Milestone 10 employer-news form. Visible only after submission; the guard
 * in recordOutcome refuses anything off the submission path, so the buttons
 * the status no longer allows simply fail closed with an explanation.
 */
export function OutcomeActions({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(recordOutcomeAction, initialApplicationActionState);
  return (
    <form action={action} className="panel">
      <div className="section-heading">
        <div>
          <h2>Record outcome</h2>
        </div>
        <button className="primary-button" type="submit" disabled={pending}>{pending ? "Recording…" : "Record update"}</button>
      </div>
      <div className="field-row">
        <label className="field">
          <span>Heard back</span>
          <select name="outcome" required defaultValue="RESPONSE">
            {OUTCOMES.map((outcome) => (
              <option key={outcome.value} value={outcome.value}>{outcome.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Note (optional, 500 characters)</span>
          <input name="note" type="text" maxLength={500} placeholder="Recruiter screen booked for Thursday" />
        </label>
      </div>
      <input type="hidden" name="jobId" value={jobId} />
      <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
    </form>
  );
}
