"use client";

import { useActionState } from "react";

import { initialEvidenceActionState } from "@/app/evidence/action-state";
import { reviewClaimAction } from "@/app/evidence/actions";

export function ClaimReviewControls({ claimId }: { claimId: string }) {
  const [state, action, pending] = useActionState(reviewClaimAction, initialEvidenceActionState);
  return (
    <form action={action} className="claim-review-form">
      <input name="claimId" type="hidden" value={claimId} />
      <div className="review-buttons">
        <button className="review-button allow" disabled={pending} name="decision" value="ALLOWED">Allow</button>
        <button className="review-button question" disabled={pending} name="decision" value="QUESTIONED">Question</button>
        <button className="review-button reject" disabled={pending} name="decision" value="REJECTED">Reject</button>
      </div>
      <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
    </form>
  );
}
