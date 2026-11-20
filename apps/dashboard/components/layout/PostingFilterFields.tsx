"use client";

import { useState } from "react";

export type CountryOption = { code: string; name: string; count: number };
export type PostingFilterChange = { country?: string | null; minHourlyPay?: number | null };

/**
 * Country and minimum-pay controls shared by the Jobs and Review toolbars.
 * Country names arrive from the server so the label never differs between
 * the server render and the browser.
 */
export function PostingFilterFields({ idPrefix, country, minHourlyPay, countries, unstatedCountries, unstated, onChange }: {
  idPrefix: string;
  country: string | null;
  minHourlyPay: number | null;
  countries: CountryOption[];
  /** Postings that state no country, for the "Not stated" option. */
  unstatedCountries: number;
  /** Postings the current filters hide only because they are silent. */
  unstated: { country: number; pay: number };
  onChange: (change: PostingFilterChange) => void;
}) {
  const [pay, setPay] = useState(minHourlyPay === null ? "" : String(minHourlyPay));
  const listed = country && country !== "none" && !countries.some((option) => option.code === country)
    ? [...countries, { code: country, name: country, count: 0 }]
    : countries;
  return (
    <>
      <label className="inline-field">
        <span>Country</span>
        <select value={country ?? ""} onChange={(event) => onChange({ country: event.target.value || null })}>
          <option value="">All countries</option>
          {listed.map((option) => <option key={option.code} value={option.code}>{option.name} ({option.count})</option>)}
          <option value="none">Not stated ({unstatedCountries})</option>
        </select>
      </label>
      <form className="inline-field" onSubmit={(event) => {
        event.preventDefault();
        const value = Number(pay);
        if (Number.isFinite(value) && value > 0 && value <= 1000) onChange({ minHourlyPay: Math.round(value * 100) / 100 });
      }}>
        <label htmlFor={`${idPrefix}-min-pay`} title="USD per hour. A posting passes when the top of its stated range meets this; monthly and yearly pay count at 2,080 hours a year.">Min pay ($/hr)</label>
        <input id={`${idPrefix}-min-pay`} type="number" min="1" max="1000" step="0.01" required value={pay}
          onChange={(event) => setPay(event.target.value)} style={{ width: "5.5rem" }} />
        <button type="submit" className="review-button">Apply pay filter</button>
        <button type="button" className="review-button" disabled={minHourlyPay === null}
          onClick={() => { setPay(""); onChange({ minHourlyPay: null }); }}>Clear pay filter</button>
      </form>
      {unstated.country > 0 ? <span className="job-list-count">{unstated.country} without a stated country excluded.</span> : null}
      {unstated.pay > 0 ? <span className="job-list-count">{unstated.pay} without stated USD pay excluded.</span> : null}
    </>
  );
}
