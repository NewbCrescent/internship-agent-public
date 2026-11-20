"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";

import { PostingFilterFields, type CountryOption } from "@/components/layout/PostingFilterFields";

type ListState = {
  sort: string; category: string | null; page: number;
  /** Undefined keeps the current value. */
  postedWithinDays?: number | null; country?: string | null; minHourlyPay?: number | null;
};

/**
 * The Jobs list toolbar: sort, category, and page live in the URL (shareable,
 * kept on refresh); expand and collapse act on the cards on this page. A new
 * page keeps the window where it is, so the list stays in view under the toolbar.
 */
export function JobCardControls({ sort, category, postedWithinDays, unknownDates, categories, country, minHourlyPay, countries, unstatedCountries, unstated, page, pageCount, pageSize, filtered, total }: {
  sort: "fit" | "newest";
  category: string | null;
  postedWithinDays: number | null;
  unknownDates: number;
  categories: Array<{ category: string; count: number }>;
  country: string | null;
  minHourlyPay: number | null;
  countries: CountryOption[];
  unstatedCountries: number;
  unstated: { country: number; pay: number };
  page: number;
  pageCount: number;
  pageSize: number;
  filtered: number;
  total: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [days, setDays] = useState(String(postedWithinDays ?? 3));
  const pathname = usePathname();
  const navigate = (next: ListState) => {
    const params = new URLSearchParams();
    const age = next.postedWithinDays === undefined ? postedWithinDays : next.postedWithinDays;
    const place = next.country === undefined ? country : next.country;
    const pay = next.minHourlyPay === undefined ? minHourlyPay : next.minHourlyPay;
    if (age !== null) params.set("days", String(age));
    if (next.sort !== "fit") params.set("sort", next.sort);
    if (next.category) params.set("category", next.category);
    if (place) params.set("country", place);
    if (pay !== null) params.set("minPay", String(pay));
    if (next.page > 1) params.set("page", String(next.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `${pathname}?${query}` : pathname, { scroll: false }));
  };
  const setAll = (open: boolean) => {
    for (const card of document.querySelectorAll<HTMLDetailsElement>("details.job-card")) card.open = open;
  };
  const first = filtered === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, filtered);
  return (
    <div className="job-card-controls" aria-label="Job list controls" aria-busy={pending}>
      <label className="inline-field">
        <span>Sort</span>
        {/* A new sort or category starts again from page 1. */}
        <select value={sort} onChange={(event) => navigate({ sort: event.target.value, category, page: 1 })}>
          <option value="fit">Fit (high to low)</option>
          <option value="newest">Newest</option>
        </select>
      </label>
      <label className="inline-field">
        <span>Category</span>
        <select value={category ?? ""} onChange={(event) => navigate({ sort, category: event.target.value || null, page: 1 })}>
          <option value="">All categories ({categories.reduce((sum, entry) => sum + entry.count, 0)})</option>
          {category && !categories.some((entry) => entry.category === category) ? <option value={category}>{category} (0)</option> : null}
          {categories.map((entry) => <option key={entry.category} value={entry.category}>{entry.category} ({entry.count})</option>)}
        </select>
      </label>
      <form className="inline-field" onSubmit={(event) => {
        event.preventDefault();
        const value = Number(days);
        if (Number.isInteger(value) && value >= 1 && value <= 365) navigate({ sort, category, page: 1, postedWithinDays: value });
      }}>
        <label htmlFor="posted-within-days">Posted within last (days)</label>
        <input id="posted-within-days" type="number" min="1" max="365" step="1" required value={days} onChange={(event) => setDays(event.target.value)} style={{ width: "5rem" }} />
        <button type="submit" className="review-button">Apply age filter</button>
        <button type="button" className="review-button" disabled={postedWithinDays === null} onClick={() => navigate({ sort, category, page: 1, postedWithinDays: null })}>Clear age filter</button>
      </form>
      <PostingFilterFields idPrefix="jobs" country={country} minHourlyPay={minHourlyPay} countries={countries}
        unstatedCountries={unstatedCountries} unstated={unstated}
        onChange={(change) => navigate({ sort, category, page: 1, ...change })} />
      {postedWithinDays !== null ? <span className="job-list-count">Posted within {postedWithinDays} {postedWithinDays === 1 ? "day" : "days"}. {unknownDates} with unknown posting dates excluded.</span> : null}
      <span className="job-list-count">Showing {first}–{last} of {filtered}{filtered !== total ? ` (${total} total)` : ""}</span>
      <nav className="job-pagination" aria-label="Job pages">
        <button type="button" className="review-button" disabled={pending || page <= 1} onClick={() => navigate({ sort, category, page: page - 1 })}>Previous</button>
        <span aria-live="polite">Page {page} of {pageCount}{pending ? " · Loading…" : ""}</span>
        <button type="button" className="review-button" disabled={pending || page >= pageCount} onClick={() => navigate({ sort, category, page: page + 1 })}>Next</button>
      </nav>
      <button type="button" className="review-button" onClick={() => setAll(true)}>Expand all</button>
      <button type="button" className="review-button" onClick={() => setAll(false)}>Collapse all</button>
    </div>
  );
}
