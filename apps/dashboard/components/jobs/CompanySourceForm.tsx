"use client";

import { useActionState } from "react";
import { initialJobActionState } from "@/app/jobs/action-state";
import { addDiscoverySourceAction, pollDiscoverySourceAction } from "@/app/jobs/actions";

export function CompanySourceForm({ sources, pipelineStartedAt }: {
  sources: Array<{
    id: string; label: string; url: string | null; lastFetchedAt: string | null;
    failureCount: number; lastError: string | null; retryAfter: string | null; importedFrom: string | null;
  }>;
  /** Set while `pnpm pipeline:run` holds this workspace's lock; board checks wait for it. */
  pipelineStartedAt: string | null;
}) {
  const [addState, addAction, addPending] = useActionState(addDiscoverySourceAction, initialJobActionState);
  const [pollState, pollAction, pollPending] = useActionState(pollDiscoverySourceAction, initialJobActionState);
  return <section className="panel" aria-label="Public internship boards">
    <div className="section-heading"><div><h2>Public job boards</h2><p>Greenhouse, Lever, or Ashby boards, or a supported GitHub internship list.</p></div></div>
    <form action={addAction} className="source-form">
      <label className="field"><span>Source label</span><input name="label" required maxLength={160} /></label>
      <label className="field"><span>Job list or board URL</span><input name="url" type="url" required placeholder="https://github.com/SimplifyJobs/Summer2027-Internships" /></label>
      <label className="field"><span>Maximum polls per minute</span><input name="rateLimitPerMinute" type="number" min={1} max={60} defaultValue={6} required /></label>
      <button className="primary-button" type="submit" disabled={addPending}>{addPending ? "Saving…" : "Add board"}</button>
      <p className={`form-message ${addState.status}`} aria-live="polite">{addState.message}</p>
    </form>
    {pipelineStartedAt ? (
      <p className="unknown-note" role="status">
        A pipeline run (started {new Date(pipelineStartedAt).toLocaleString()}) is checking these boards. Check board is disabled until it finishes.
      </p>
    ) : null}
    <ul className="fact-list">{sources.map((source) => <li key={source.id}>
      <strong>{source.label}</strong> · {source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">View source</a> : null}
      {source.lastFetchedAt ? <span> · last attempted {new Date(source.lastFetchedAt).toLocaleString()}</span> : null}
      {source.importedFrom ? <span> · imported from {source.importedFrom}</span> : null}
      {source.failureCount > 0 ? <span> · failing ({source.failureCount}): {source.lastError}{source.retryAfter ? `; next automatic check after ${new Date(source.retryAfter).toLocaleString()}` : ""}</span> : null}
      <form action={pollAction}><input type="hidden" name="sourceId" value={source.id} /><button className="review-button" type="submit" disabled={pollPending || pipelineStartedAt !== null}>Check board</button></form>
    </li>)}</ul>
    <p className={`form-message ${pollState.status}`} aria-live="polite">{pollState.message}</p>
  </section>;
}
