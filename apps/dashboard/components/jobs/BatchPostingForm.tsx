"use client";

import { useActionState } from "react";

import { initialJobActionState } from "@/app/jobs/action-state";
import { discoverBatchAction } from "@/app/jobs/actions";

export function BatchPostingForm() {
  const [state, action, pending] = useActionState(discoverBatchAction, initialJobActionState);
  return (
    <form action={action} className="panel">
      <div className="section-heading">
        <div>
          <h2>Paste a batch</h2>
        </div>
        <button className="primary-button" type="submit" disabled={pending}>{pending ? "Processing…" : "Discover batch"}</button>
      </div>
      <label className="field">
        <span>Postings <small>separate with ===; first line of each is Title @ Company</small></span>
        <textarea
          name="batchText"
          rows={6}
          required
          placeholder={"Software Engineering Intern @ Aurora Labs\nSource: https://example.com/jobs/1\nWe build our platform in Python. This internship runs twelve weeks in Seattle…\n===\nData Engineering Intern @ Beacon Systems\nSQL and Python…"}
        />
      </label>
      <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
    </form>
  );
}
