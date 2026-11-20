"use client";

import { useActionState } from "react";

import type { Candidate } from "@internship-agent/domain";

import { initialFormActionState } from "@/app/profile/action-state";
import { updateProfileAction } from "@/app/profile/actions";

export function CandidateProfileForm({ candidate }: { candidate: Candidate | null }) {
  const [state, action, pending] = useActionState(updateProfileAction, initialFormActionState);

  return (
    <section className="panel form-panel">
      <div className="section-heading"><div><h2>Candidate profile</h2></div><span className="pill">Local</span></div>
      <form action={action} className="form-grid">
        <Field label="Full name" name="fullName" defaultValue={candidate?.fullName} required />
        <Field label="Preferred name" name="preferredName" defaultValue={candidate?.preferredName} />
        <Field label="Email" name="email" defaultValue={candidate?.email} type="email" />
        <Field label="Phone" name="phone" defaultValue={candidate?.phone} />
        <Field label="School" name="school" defaultValue={candidate?.school} />
        <Field label="Degree" name="degree" defaultValue={candidate?.degree} />
        <Field label="Graduation date" name="graduationDate" defaultValue={candidate?.graduationDate} type="date" />
        <Field label="GPA (as on your resume)" name="gpa" defaultValue={candidate?.gpa} />
        <Field label="GitHub URL" name="githubUrl" defaultValue={candidate?.githubUrl} type="url" />
        <Field label="LinkedIn URL" name="linkedinUrl" defaultValue={candidate?.linkedinUrl} type="url" />
        <Field label="Portfolio URL" name="portfolioUrl" defaultValue={candidate?.portfolioUrl} type="url" />
        <fieldset className="form-subsection" aria-label="Contact details for applications">
          <legend>Contact details for applications</legend>
          <p className="form-help">Used as entered on forms like Workday. Stays on this computer.</p>
          <Field label="Legal first name" name="legalFirstName" defaultValue={candidate?.legalFirstName} />
          <Field label="Legal last name" name="legalLastName" defaultValue={candidate?.legalLastName} />
          <Field label="Address line 1" name="addressLine1" defaultValue={candidate?.addressLine1} />
          <Field label="Address line 2" name="addressLine2" defaultValue={candidate?.addressLine2} />
          <Field label="City" name="addressCity" defaultValue={candidate?.addressCity} />
          <Field label="State or province" name="addressRegion" defaultValue={candidate?.addressRegion} />
          <Field label="Postal code" name="addressPostalCode" defaultValue={candidate?.addressPostalCode} />
          <Field label="Country" name="addressCountry" defaultValue={candidate?.addressCountry} />
          <label className="field">
            <span>Phone type</span>
            <select name="phoneType" defaultValue={candidate?.phoneType ?? ""}>
              <option value="">Not set</option>
              <option value="Mobile">Mobile</option>
              <option value="Home">Home</option>
              <option value="Work">Work</option>
            </select>
          </label>
          <Field label="Field of study" name="fieldOfStudy" defaultValue={candidate?.fieldOfStudy} />
          <Field label="Education start month" name="educationStartMonth" defaultValue={candidate?.educationStartMonth} type="month" />
          <Field label="High school" name="highSchoolName" defaultValue={candidate?.highSchoolName} />
          <Field label="High school start year" name="highSchoolStartYear" defaultValue={candidate?.highSchoolStartYear} />
          <Field label="High school end year" name="highSchoolEndYear" defaultValue={candidate?.highSchoolEndYear} />
          <p className="form-help">High school is used on application forms only, never printed on your resume.</p>
        </fieldset>
        <div className="form-footer">
          <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
          <button className="primary-button" disabled={pending} type="submit">{pending ? "Saving…" : "Save profile"}</button>
        </div>
      </form>
    </section>
  );
}

function Field({ label, name, defaultValue, required, type = "text" }: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} type={type} defaultValue={defaultValue ?? ""} required={required} />
    </label>
  );
}
