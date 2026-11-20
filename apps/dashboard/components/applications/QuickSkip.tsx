"use client";

import { useActionState } from "react";

import { initialApplicationActionState } from "@/app/applications/action-state";
import { skipReviewJobAction } from "@/app/review/actions";

const REASONS: Array<[string, string]> = [["role", "Role"], ["location", "Location"], ["pay", "Pay"], ["company", "Company"], ["closed", "Closed"]];

/** Two clicks, no typing: open the menu, pick why. */
export function QuickSkip({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(skipReviewJobAction, initialApplicationActionState);
  return (
    <details className="quick-skip">
      <summary>Not for me</summary>
      <form action={action} className="quick-skip-menu" aria-label="Why skip">
        <input type="hidden" name="jobId" value={jobId} />
        {REASONS.map(([value, label]) => (
          <button key={value} type="submit" name="reason" value={value} className="review-button" disabled={pending}>{label}</button>
        ))}
        <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
      </form>
    </details>
  );
}
