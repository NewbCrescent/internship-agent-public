"use client";

import { useActionState } from "react";

import type { ReviewFocus } from "@internship-agent/domain";

import { initialApplicationActionState } from "@/app/applications/action-state";
import { saveReviewFocusAction } from "@/app/review/actions";

/** What the focus view keeps, folded under a one-line summary. Labels and lists come from the server. */
export function FocusSettings({ focus, summary, categories, requiredCategory, countries }: {
  focus: ReviewFocus;
  summary: string;
  categories: readonly string[];
  requiredCategory: string;
  countries: Array<{ code: string; name: string; count: number }>;
}) {
  const [state, action, pending] = useActionState(saveReviewFocusAction, initialApplicationActionState);
  return (
    <details className="panel focus-settings">
      <summary>{summary}</summary>
      <form action={action} className="form-grid focus-form">
        <fieldset className="field checkbox-field">
          <legend>Role categories</legend>
          <div className="checkbox-row">
            {categories.map((category) => (
              <label key={category}>
                <input type="checkbox" name="categories" value={category} disabled={category === requiredCategory}
                  defaultChecked={category === requiredCategory || focus.categories.includes(category as ReviewFocus["categories"][number])} /> {category}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="field checkbox-field">
          <legend>Countries</legend>
          <div className="checkbox-row">
            {countries.map((country) => (
              <label key={country.code}>
                <input type="checkbox" name="countries" value={country.code} defaultChecked={focus.countries.includes(country.code)} /> {country.name} ({country.count})
              </label>
            ))}
            <label><input type="checkbox" name="includeUnstatedCountry" defaultChecked={focus.includeUnstatedCountry} /> No stated location</label>
          </div>
        </fieldset>
        <label className="field"><span>Posted within (days)</span>
          <input name="postedWithinDays" type="number" min="1" max="365" step="1" required defaultValue={focus.postedWithinDays} />
        </label>
        <label className="field"><span>Min pay ($/hr) <small>blank for any; postings without pay stay in</small></span>
          <input name="minHourlyPay" type="number" min="1" max="1000" step="0.01" defaultValue={focus.minHourlyPay ?? ""} />
        </label>
        <div className="form-footer">
          <p className={`form-message ${state.status}`} aria-live="polite">{state.message}</p>
          <button className="primary-button" type="submit" disabled={pending}>{pending ? "Saving…" : "Save focus"}</button>
        </div>
      </form>
    </details>
  );
}
