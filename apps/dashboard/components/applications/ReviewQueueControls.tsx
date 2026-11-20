"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ReviewQueueSort } from "@internship-agent/domain";

import { PostingFilterFields, type CountryOption, type PostingFilterChange } from "@/components/layout/PostingFilterFields";

export function ReviewQueueControls({ sort, postedWithinDays, unknownDates, total, queueTotal, country, minHourlyPay, countries, unstatedCountries, unstated }: {
  sort: ReviewQueueSort; postedWithinDays: number | null; unknownDates: number; total: number; queueTotal: number;
  country: string | null; minHourlyPay: number | null; countries: CountryOption[]; unstatedCountries: number;
  unstated: { country: number; pay: number };
}) {
  const router = useRouter();
  const [days, setDays] = useState(String(postedWithinDays ?? 3));
  // Any change starts again from page 1; filters not being changed are kept.
  const navigate = (nextSort: string, age: number | null, change: PostingFilterChange = {}) => {
    const query = new URLSearchParams({ view: "all", sort: nextSort });
    if (age !== null) query.set("days", String(age));
    const place = change.country === undefined ? country : change.country;
    const pay = change.minHourlyPay === undefined ? minHourlyPay : change.minHourlyPay;
    if (place) query.set("country", place);
    if (pay !== null) query.set("minPay", String(pay));
    router.push(`/review?${query}`, { scroll: false });
  };
  return (
    <div className="job-card-controls" role="group" aria-label="Review queue controls">
      <label className="inline-field">
        <span>Sort</span>
        <select value={sort} onChange={(event) => navigate(event.target.value, postedWithinDays)}>
          <option value="fit">Fit (high to low)</option>
          <option value="newest">Newest</option>
        </select>
      </label>
      <form className="inline-field" onSubmit={(event) => {
        event.preventDefault();
        const value = Number(days);
        if (Number.isInteger(value) && value >= 1 && value <= 365) navigate(sort, value);
      }}>
        <label htmlFor="review-posted-within-days">Posted within last (days)</label>
        <input id="review-posted-within-days" type="number" min="1" max="365" step="1" required value={days}
          onChange={(event) => setDays(event.target.value)} style={{ width: "5rem" }} />
        <button type="submit" className="review-button">Apply age filter</button>
        <button type="button" className="review-button" disabled={postedWithinDays === null}
          onClick={() => navigate(sort, null)}>Clear age filter</button>
      </form>
      <PostingFilterFields idPrefix="review" country={country} minHourlyPay={minHourlyPay} countries={countries}
        unstatedCountries={unstatedCountries} unstated={unstated}
        onChange={(change) => navigate(sort, postedWithinDays, change)} />
      {postedWithinDays !== null ? <span className="job-list-count">Posted within {postedWithinDays} {postedWithinDays === 1 ? "day" : "days"}. {unknownDates} with unknown posting dates excluded.</span> : null}
      <span className="job-list-count">{total} matching · {queueTotal} in entire queue</span>
    </div>
  );
}
