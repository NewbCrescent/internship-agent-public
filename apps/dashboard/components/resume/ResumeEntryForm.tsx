"use client";

import { useActionState, useState } from "react";

import type { ResumeEntry, ResumeSection } from "@internship-agent/domain";

import { initialResumeActionState } from "@/app/resume/action-state";
import { saveResumeEntryAction } from "@/app/resume/actions";

const LABELS: Record<ResumeSection, { title: string; bullets: string }> = {
  experience: { title: "Organization", bullets: "Bullets (one per line)" },
  project: { title: "Project name", bullets: "Bullets (one per line)" },
  skills: { title: "Group label (e.g. Languages)", bullets: "Items (one per line)" }
};

/** Adds a new entry, or saves an edit to an existing one as a new approved revision. */
export function ResumeEntryForm({ entry }: { entry?: ResumeEntry }) {
  const [state, action, pending] = useActionState(saveResumeEntryAction, initialResumeActionState);
  const [section, setSection] = useState<ResumeSection>(entry?.section ?? "experience");
  const current = entry?.current;
  const labels = LABELS[section];
  return (
    <form action={action} className="form-grid resume-entry-form">
      {entry ? <input type="hidden" name="entryId" value={entry.id} /> : (
        <label className="field"><span>Section</span>
          <select name="section" value={section} onChange={(event) => setSection(event.target.value as ResumeSection)}>
            <option value="experience">Professional Experience</option>
            <option value="project">Project</option>
            <option value="skills">Technical Skills group</option>
          </select>
        </label>
      )}
      <label className="field"><span>{labels.title}</span><input name="title" required maxLength={160} defaultValue={current?.title ?? ""} /></label>
      {section === "experience" ? (
        <label className="field"><span>Role</span><input name="role" maxLength={160} defaultValue={current?.role ?? ""} /></label>
      ) : null}
      {section === "project" ? (
        <>
          <label className="field"><span>Link label <small>optional</small></span><input name="linkLabel" maxLength={80} defaultValue={current?.linkLabel ?? ""} placeholder="driftroom.app" /></label>
          <label className="field"><span>Link URL <small>optional</small></span><input name="linkUrl" type="url" defaultValue={current?.linkUrl ?? ""} placeholder="https://" /></label>
        </>
      ) : null}
      {section !== "skills" ? (
        <>
          <label className="field"><span>Location <small>as written</small></span><input name="location" maxLength={80} defaultValue={current?.location ?? ""} placeholder="Berkeley, CA" /></label>
          <label className="field"><span>Date <small>as written</small></span><input name="dateText" maxLength={60} defaultValue={current?.dateText ?? ""} placeholder="2026" /></label>
        </>
      ) : null}
      {section === "experience" ? (
        <fieldset className="form-subsection" aria-label="Dates for application forms">
          <legend>Dates for application forms</legend>
          <p className="form-help">Workday and similar forms ask for months. They are not printed on your resume.</p>
          <label className="field"><span>Start month</span><input name="startMonth" type="month" defaultValue={current?.startMonth ?? ""} /></label>
          <label className="field"><span>End month</span><input name="endMonth" type="month" defaultValue={current?.endMonth ?? ""} /></label>
          <label className="checkbox-field"><input name="isCurrent" type="checkbox" defaultChecked={current?.isCurrent ?? false} /> I currently work here</label>
        </fieldset>
      ) : null}
      <label className="field resume-bullets-field"><span>{labels.bullets}</span>
        <textarea name="bullets" rows={section === "skills" ? 3 : 4} required defaultValue={current?.bullets.join("\n") ?? ""} />
      </label>
      <div className="form-footer">
        <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
        <button className="primary-button" disabled={pending} type="submit">{pending ? "Saving…" : entry ? "Save edit" : "Add entry"}</button>
      </div>
    </form>
  );
}
