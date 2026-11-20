"use client";

import { useActionState } from "react";

import { initialJobActionState } from "@/app/jobs/action-state";
import { ingestPostingAction } from "@/app/jobs/actions";

export function PostingIngestForm() {
  const [state, action, pending] = useActionState(ingestPostingAction, initialJobActionState);
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Add a posting</h2>
        </div>
      </div>
      <form action={action} className="posting-form">
        <div className="field-row">
          <label className="field">
            <span>Company</span>
            <input name="companyName" placeholder="Northstar Systems" required />
          </label>
          <label className="field">
            <span>Title</span>
            <input name="title" placeholder="Software Engineering Intern" required />
          </label>
        </div>
        <label className="field">
          <span>Source URL</span>
          <input name="sourceUrl" placeholder="https://app.joinhandshake.com/jobs/123456" required type="url" />
        </label>
        <div className="field-row">
          <label className="field">
            <span>External application URL (optional)</span>
            <input name="externalApplicationUrl" placeholder="https://boards.greenhouse.io/…" type="url" />
          </label>
          <label className="field">
            <span>Company careers URL (optional)</span>
            <input name="companyCareersUrl" placeholder="https://example.com/careers" type="url" />
          </label>
        </div>
        <label className="field">
          <span>Posting content</span>
          <textarea
            name="content"
            placeholder="Paste the full posting text, including requirements and qualifications."
            required
            rows={12}
          />
          <small>Requirements are quoted from this text, never inferred.</small>
        </label>
        <button className="primary-button align-end" disabled={pending} type="submit">
          {pending ? "Normalizing…" : "Ingest posting"}
        </button>
      </form>
      <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
    </section>
  );
}
