"use client";

import { useActionState } from "react";

import { initialApplicationActionState } from "@/app/applications/action-state";
import { approveApplicationAction, withdrawApplicationAction } from "@/app/applications/actions";

export function ReviewActions({ jobId, status, canApprove, manualOnly }: { jobId: string; status: string; canApprove: boolean; manualOnly?: boolean }) {
  const decided = status === "APPROVED" || status === "SUBMITTED" || status === "WITHDRAWN";
  const [approveState, approve, approvePending] = useActionState(approveApplicationAction, initialApplicationActionState);
  const [withdrawState, withdraw, withdrawPending] = useActionState(withdrawApplicationAction, initialApplicationActionState);
  return (
    <div className="review-actions">
      {canApprove && !manualOnly ? (
        <form action={approve}>
          <input type="hidden" name="jobId" value={jobId} />
          <button type="submit" disabled={approvePending} className="primary-button">
            {approvePending ? "Approving…" : "Approve package"}
          </button>
        </form>
      ) : decided ? null : (
        <p className="unknown-note">Approval unlocks once the package is verified.</p>
      )}
      <form action={withdraw}>
        <input type="hidden" name="jobId" value={jobId} />
        <button className="danger-button" type="submit" disabled={withdrawPending}>Withdraw</button>
      </form>
      <p className={`form-message ${approveState.status}`} aria-live="polite">{approveState.message}</p>
      <p className={`form-message ${withdrawState.status}`} aria-live="polite">{withdrawState.message}</p>
    </div>
  );
}
