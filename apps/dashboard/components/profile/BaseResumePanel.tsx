"use client";

import { useActionState } from "react";

import type { BaseResume, CandidateDocument, ResumeSourceSetting } from "@internship-agent/domain";

import { initialFormActionState } from "@/app/profile/action-state";
import { uploadBaseResumeAction } from "@/app/profile/actions";

type Slot = BaseResume["channel"] | "transcript";

const SLOT_LABELS: Record<Slot, string> = {
  default: "Default resume",
  handshake_internal: "2029 resume",
  transcript: "Transcript"
};

function slotUse(resumeSource: ResumeSourceSetting): Record<Slot, string> {
  const notSent = "Not sent: INTERNSHIP_AGENT_RESUME_SOURCE=generated uploads the tailored resume.";
  return {
    default: resumeSource === "generated" ? notSent : "Sent byte for byte on default-profile (2028) applications.",
    handshake_internal: resumeSource === "generated"
      ? notSent
      : "Sent byte for byte on 2029-profile applications (Handshake Apply, or forms that ask for a transcript).",
    transcript: "Uploaded only where a transcript is asked for."
  };
}

export function BaseResumePanel({ resumes, documents, resumeSource }: {
  resumes: BaseResume[];
  documents: CandidateDocument[];
  resumeSource: ResumeSourceSetting;
}) {
  const use = slotUse(resumeSource);
  const [state, action, pending] = useActionState(uploadBaseResumeAction, initialFormActionState);
  return (
    <section className="panel form-panel" data-testid="base-resumes">
      <div className="section-heading">
        <div><h2>Resumes & transcript</h2></div>
        <span className="pill muted-pill">Local only</span>
      </div>
      <div className="fact-list">
        {(["default", "handshake_internal", "transcript"] as const).map((slot) => {
          const file = slot === "transcript"
            ? documents.find((entry) => entry.kind === "transcript")
            : resumes.find((entry) => entry.channel === slot);
          return (
            <article className="fact-row" key={slot}>
              <div className="fact-primary">
                <span className="fact-icon">{file ? "✓" : "–"}</span>
                <div>
                  <strong>{SLOT_LABELS[slot]}</strong>
                  <span>{file ? `${file.originalName} · ${Math.ceil(file.byteSize / 1024)} KB · sha256 ${file.sha256.slice(0, 12)}…` : "Not uploaded"}</span>
                </div>
              </div>
              <div className="fact-value"><small>{use[slot]}</small></div>
            </article>
          );
        })}
      </div>
      <form action={action} className="form-grid">
        <label className="field"><span>PDF file</span><input type="file" name="resume" accept="application/pdf,.pdf" required /></label>
        <label className="field"><span>Use for</span>
          <select name="channel" defaultValue="handshake_internal">
            <option value="handshake_internal">{SLOT_LABELS.handshake_internal}</option>
            <option value="default">{SLOT_LABELS.default}</option>
            <option value="transcript">{SLOT_LABELS.transcript}</option>
          </select>
        </label>
        <label className="field"><span>Label <small>optional</small></span><input name="label" maxLength={120} placeholder="Resume (Expected May 2029)" /></label>
        <div className="form-footer">
          <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
          <button className="secondary-button" disabled={pending} type="submit">{pending ? "Uploading…" : "Upload file"}</button>
        </div>
      </form>
    </section>
  );
}
