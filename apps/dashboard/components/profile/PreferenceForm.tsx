"use client";

import { useActionState } from "react";

import type { CandidatePreference } from "@internship-agent/domain";

import { initialFormActionState } from "@/app/profile/action-state";
import { updatePreferencesAction } from "@/app/profile/actions";

export function PreferenceForm({ preferences }: { preferences: CandidatePreference | null }) {
  const [state, action, pending] = useActionState(updatePreferencesAction, initialFormActionState);
  return (
    <section className="panel form-panel">
      <div className="section-heading"><div><h2>Preferences</h2></div><span className="pill muted-pill">Not facts</span></div>
      <form action={action} className="form-grid">
        <TextArea label="Role types" name="roleTypes" defaultValue={preferences?.roleTypes.join(", ")} />
        <TextArea label="Target locations" name="locations" defaultValue={preferences?.locations.join(", ")} />
        <TextArea label="Industries" name="industries" defaultValue={preferences?.industries.join(", ")} />
        <fieldset className="field checkbox-field">
          <legend>Work modes</legend>
          <div className="checkbox-row">
            {(["remote", "hybrid", "onsite"] as const).map((mode) => (
              <label key={mode}><input type="checkbox" name="workModes" value={mode} defaultChecked={preferences?.workModes.includes(mode)} /> {mode}</label>
            ))}
          </div>
        </fieldset>
        <label className="field checkbox-field">
          <span><input type="checkbox" name="excludeGraduateOnlyInternships" defaultChecked={preferences?.excludeGraduateOnlyInternships ?? false} /> Exclude Master&apos;s and PhD internships</span>
          <small>Skips graduate-only titles and requirements.</small>
        </label>
        <p className="form-help">Separate entries with commas. Used for matching only.</p>
        <div className="form-footer">
          <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
          <button className="secondary-button" disabled={pending} type="submit">{pending ? "Saving…" : "Save preferences"}</button>
        </div>
      </form>
    </section>
  );
}

function TextArea({ label, name, defaultValue }: { label: string; name: string; defaultValue?: string }) {
  return <label className="field"><span>{label}</span><textarea name={name} rows={2} defaultValue={defaultValue ?? ""} /></label>;
}
