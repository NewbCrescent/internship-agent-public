"use client";
import { useActionState } from "react";
import { analyzeFitAiAction } from "@/app/jobs/actions";
import { initialJobActionState } from "@/app/jobs/action-state";
export function AiFitButton({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(analyzeFitAiAction, initialJobActionState);
  return <form action={action}>
    <input type="hidden" name="jobId" value={jobId} />
    <button className="secondary-button" type="submit" disabled={pending}>{pending ? "Analyzing fit with AI…" : "Analyze fit with AI"}</button>
    <p role="status" className={`form-message ${state.status}`}>{state.message}</p>
  </form>;
}
