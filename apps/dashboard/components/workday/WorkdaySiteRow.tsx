"use client";

import { useActionState } from "react";

import { initialWorkdayActionState } from "@/app/workday/action-state";
import { connectWorkdaySiteAction } from "@/app/workday/actions";

const STATUS_LABELS = { connected: "Connected", signed_out: "Signed out", unknown: "Unknown" } as const;

export function WorkdaySiteRow({ site }: {
  site: {
    siteKey: string; host: string; companies: string[]; applications: number; jobUrl: string;
    session: { status: keyof typeof STATUS_LABELS; detail: string; checkedAt: string } | null;
  };
}) {
  const [state, action, pending] = useActionState(connectWorkdaySiteAction, initialWorkdayActionState);
  return (
    <li className="workday-site" aria-label={`Workday site ${site.companies.join(", ")}`}>
      <div className="workday-site-heading">
        <div>
          <strong>{site.companies.join(", ")}</strong>
          <span className="job-card-meta"> · {site.host} · {site.applications} {site.applications === 1 ? "application" : "applications"} waiting</span>
        </div>
        <span className="pill">{site.session ? STATUS_LABELS[site.session.status] : "Not connected"}</span>
      </div>
      {site.session ? (
        <p className="unknown-note">Last checked {new Date(site.session.checkedAt).toLocaleString("en-US")}: {site.session.detail}</p>
      ) : null}
      <form action={action} className="form-footer">
        <input type="hidden" name="siteKey" value={site.siteKey} />
        <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
        <button className="secondary-button" disabled={pending} type="submit">
          {pending ? "Opening…" : site.session?.status === "connected" ? "Sign in again" : "Open sign-in"}
        </button>
      </form>
    </li>
  );
}
