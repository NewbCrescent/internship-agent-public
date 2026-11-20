"use client";

import { useActionState } from "react";

import type { CurrentPackage } from "@internship-agent/agent";

import { initialJobActionState } from "@/app/jobs/action-state";
import { prepareApplicationAction } from "@/app/jobs/actions";

export function ApplicationPanel({ jobId, current }: { jobId: string; current: CurrentPackage | null }) {
  const [state, action, pending] = useActionState(prepareApplicationAction, initialJobActionState);
  const verification = current?.verification ?? null;
  const failing = verification?.checks.filter((check) => check.verdict !== "SUPPORTED") ?? [];

  return (
    <div className="application-panel">
      <div className="section-heading">
        <div>
          <h3>
            {current
              ? verification?.blocked === false
                ? "Verified · ready for review"
                : verification
                  ? "Blocked · needs candidate input"
                  : "Prepared · awaiting verification"
              : "No package yet"}
          </h3>
        </div>
        <form action={action}>
          <input type="hidden" name="jobId" value={jobId} />
          <button className={current ? "secondary-button" : "primary-button"} type="submit" disabled={pending}>
            {pending ? "Preparing…" : current ? "Rebuild package" : "Prepare application"}
          </button>
        </form>
      </div>

      {current ? (
        <>
          <p>{current.package.summary}</p>
          {current.package.answers.map((answer) => (
            <article key={answer.id} className="answer-block">
              <h4>{answer.prompt}</h4>
              <p>{answer.text}</p>
            </article>
          ))}
          {current.package.bullets.length > 0 ? (
            <ul className="bullet-list" aria-label="Resume bullets">
              {current.package.bullets.map((bullet) => <li key={bullet.id}>{bullet.text}</li>)}
            </ul>
          ) : null}
          {failing.length > 0 ? (
            <ul className="finding-list failures" aria-label="Verification findings">
              {failing.map((check) => (
                <li key={check.claimId}>
                  <strong>{check.verdict.toLocaleLowerCase("en-US")}</strong>: {check.reason}
                </li>
              ))}
            </ul>
          ) : (
            <p className="unknown-note">
              Every claim traces to allowed evidence, a saved fact, or the posting.
            </p>
          )}
        </>
      ) : (
        <p className="form-help">Builds answers and a resume from your verified sources, then checks every claim.</p>
      )}
      <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
    </div>
  );
}
