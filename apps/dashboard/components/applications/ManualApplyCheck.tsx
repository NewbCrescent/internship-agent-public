"use client";

import { useActionState } from "react";

import { initialApplicationActionState } from "@/app/applications/action-state";
import { recordManualApplicationAction } from "@/app/review/actions";

/** One click and a confirmation: recording a self-submitted application cannot be undone. */
export function ManualApplyCheck({ jobId, title }: { jobId: string; title: string }) {
  const [state, action, pending] = useActionState(recordManualApplicationAction, initialApplicationActionState);
  return (
    <form action={action} className="manual-check" onSubmit={(event) => {
      if (!window.confirm(`Mark "${title}" as applied? It moves to Applications and can't be undone.`)) event.preventDefault();
    }}>
      <input type="hidden" name="jobId" value={jobId} />
      <button type="submit" disabled={pending} className="secondary-button">{pending ? "Saving…" : "Applied ✓"}</button>
      <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
    </form>
  );
}
