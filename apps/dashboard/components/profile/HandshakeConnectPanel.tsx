"use client";

import { useActionState } from "react";

import type { BrowserSession } from "@internship-agent/domain";

import { initialFormActionState } from "@/app/profile/action-state";
import { connectHandshakeAction } from "@/app/profile/actions";

const STATUS_LABELS: Record<BrowserSession["status"], string> = {
  connected: "Connected",
  signed_out: "Signed out",
  unknown: "Unknown"
};

export function HandshakeConnectPanel({ session }: { session: BrowserSession | null }) {
  const [state, action, pending] = useActionState(connectHandshakeAction, initialFormActionState);
  return (
    <section className="panel form-panel" data-testid="handshake-connection">
      <div className="section-heading">
        <div><h2>Handshake</h2></div>
        <span className="pill">{session ? STATUS_LABELS[session.status] : "Not connected"}</span>
      </div>
      <p className="form-help">
        Opens Handshake in a browser window. Sign in yourself, then close it. The agent never sees your password.
        {session ? ` Last checked ${new Date(session.checkedAt).toLocaleString("en-US")}: ${session.detail}` : ""}
      </p>
      <form action={action} className="form-footer">
        <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
        <button className="secondary-button" disabled={pending} type="submit">{pending ? "Opening…" : "Connect Handshake"}</button>
      </form>
    </section>
  );
}
