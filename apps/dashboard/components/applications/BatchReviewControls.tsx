"use client";

import Link from "next/link";
import { useActionState } from "react";
import { initialApplicationActionState } from "@/app/applications/action-state";
import { skipReviewBatchAction } from "@/app/review/actions";

export function BatchReviewControls({ jobs }: { jobs: Array<{ jobId: string; title: string; companyName: string }> }) {
  const [state, action, pending] = useActionState(skipReviewBatchAction, initialApplicationActionState);
  if (jobs.length === 0) return null;
  return (
    <form action={action} className="panel" aria-label="Batch review feedback">
      <div className="section-heading"><div><h2>Skip postings</h2><p>Choose postings on this page to drop from the queue. Your <Link href="/profile">preferences</Link> stay the same.</p></div></div>
      <ul className="fact-list">
        {jobs.map((job) => <li key={job.jobId}><label><input type="checkbox" name="jobIds" value={job.jobId} /> {job.title} · {job.companyName}</label></li>)}
      </ul>
      <label className="field"><span>Reason</span><input name="reason" required maxLength={300} placeholder="Not a role I want to pursue" /></label>
      <label className="field"><span>Preference feedback (optional, saved as a note)</span><input name="preferenceNote" maxLength={300} placeholder="Prefer backend internship roles" /></label>
      <button className="secondary-button" type="submit" disabled={pending}>{pending ? "Saving…" : "Skip selected"}</button>
      <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
    </form>
  );
}
