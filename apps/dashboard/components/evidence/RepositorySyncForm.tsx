"use client";

import { useActionState } from "react";

import { initialEvidenceActionState } from "@/app/evidence/action-state";
import { syncRepositoryAction } from "@/app/evidence/actions";

export function RepositorySyncForm() {
  const [state, action, pending] = useActionState(syncRepositoryAction, initialEvidenceActionState);
  return (
    <section className="panel">
      <div className="section-heading">
        <div><h2>Connect a public repository</h2></div>
        <span className="pill">GitHub</span>
      </div>
      <form action={action} className="repository-form">
        <label className="field">
          <span>Repository URL or owner/repository</span>
          <input name="repository" placeholder="https://github.com/owner/repository" required />
          <small>Only selected text files are read. Repository code is never executed.</small>
        </label>
        <button className="primary-button align-end" disabled={pending} type="submit">
          {pending ? "Syncing…" : "Sync evidence"}
        </button>
      </form>
      <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
    </section>
  );
}
