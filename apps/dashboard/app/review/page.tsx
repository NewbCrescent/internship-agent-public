import Link from "next/link";

import { getDiscoverySkipsWithTitles, getReviewQueuePage } from "@internship-agent/agent";
import { countryName, FOCUS_REQUIRED_CATEGORY, manualOnly, ROLE_TYPES, type ReviewFocus } from "@internship-agent/domain";

import { BatchReviewControls } from "@/components/applications/BatchReviewControls";
import { FocusSettings } from "@/components/applications/FocusSettings";
import { ListPagination } from "@/components/layout/ListPagination";
import { ReviewCard } from "@/components/applications/ReviewCard";
import { ReviewQueueControls } from "@/components/applications/ReviewQueueControls";
import { refreshResumeAction, restoreReviewJobAction } from "./actions";
import { getActiveDatabase } from "@/lib/active-profile";

export const dynamic = "force-dynamic";

function focusSummary(focus: ReviewFocus): string {
  const places = [...focus.countries.map(countryName), ...(focus.includeUnstatedCountry ? ["no stated location"] : [])];
  return [
    `Focus: ${focus.categories.join(", ")}`,
    places.length ? places.join(" + ") : "no countries",
    `last ${focus.postedWithinDays} days`,
    focus.minHourlyPay === null ? "any pay" : `$${focus.minHourlyPay}/hr or unstated`
  ].join(" · ");
}

export default async function ReviewQueuePage({ searchParams }: {
  searchParams: Promise<{ page?: string; sort?: string; days?: string; country?: string; minPay?: string; view?: string }>;
}) {
  const database = await getActiveDatabase();
  const result = getReviewQueuePage(database, await searchParams);
  const { queue } = result;
  const focusView = result.view === "focus";
  const changed = queue.filter((entry) => entry.resumeChanged);
  const skipped = focusView ? [] : getDiscoverySkipsWithTitles(database);
  const manual = manualOnly();
  const countryOptions = [...result.queueCountries, ...result.focus.countries
    .filter((code) => !result.queueCountries.some((entry) => entry.code === code)).map((code) => ({ code, count: 0 }))]
    .map((entry) => ({ ...entry, name: countryName(entry.code) }));

  return (
    <div className="page-stack">
      <header className="page-header compact-header">
        <div>
          <h1>Review Queue</h1>
          <p>{focusView
            ? "Your best matches first: ranked by AI fit, then pay."
            : manual ? "Everything waiting, with the full filters." : "Waiting on your approval or input. Nothing here submits on its own."}</p>
        </div>
      </header>

      <nav className="filter-row" aria-label="Review views">
        <Link className={focusView ? "pill pill-active" : "pill"} href="/review">Focus ({result.focusTotal})</Link>
        <Link className={focusView ? "pill" : "pill pill-active"} href="/review?view=all">All ({result.queueTotal})</Link>
      </nav>

      {focusView ? (
        <FocusSettings focus={result.focus} summary={focusSummary(result.focus)} categories={ROLE_TYPES}
          requiredCategory={FOCUS_REQUIRED_CATEGORY} countries={countryOptions} />
      ) : null}

      {result.queueTotal > 0 ? (
        <section className="panel" aria-label="Resume changes">
          <div className="section-heading">
            <div>
              <h2>{changed.length === 0 ? "Resumes on this page are current" : `${changed.length} on this page used an older resume`}</h2>
              <p>Refresh all rebuilds and re-verifies every changed application in the queue, including filtered ones. Unsubmitted filled forms are refilled.</p>
            </div>
            <form action={refreshResumeAction}>
              <input type="hidden" name="scope" value="all" />
              <button className="secondary-button" type="submit">Refresh all</button>
            </form>
          </div>
        </section>
      ) : null}

      {focusView ? null : (
        <ReviewQueueControls key={`${result.sort}|${result.postedWithinDays ?? ""}|${result.minHourlyPay ?? ""}`}
          sort={result.sort} postedWithinDays={result.postedWithinDays} unknownDates={result.unknownDates}
          total={result.total} queueTotal={result.queueTotal}
          country={result.country} minHourlyPay={result.minHourlyPay}
          countries={result.countries.countries.map((entry) => ({ ...entry, name: countryName(entry.code) }))}
          unstatedCountries={result.countries.unstated} unstated={result.unstated} />
      )}

      {focusView
        ? <ListPagination path="/review" page={result.page} pageCount={result.pageCount} total={result.total} pageSize={result.pageSize} />
        : <ListPagination path="/review" {...result} />}

      {focusView ? null : <BatchReviewControls jobs={queue.map(({ jobId, title, companyName }) => ({ jobId, title, companyName }))} />}

      {queue.length === 0 ? (
        <section className="panel empty-state">
          {result.queueTotal === 0 ? (
            <><h3>Queue is clear</h3><p>Prepared postings from <Link href="/jobs">Jobs</Link> wait here.</p></>
          ) : focusView ? (
            <><h3>Nothing in focus right now</h3><p>Widen the focus above, or see <Link href="/review?view=all">all {result.queueTotal}</Link>.</p></>
          ) : (
            <><h3>No applications match this filter</h3><p>Clear or widen the filters.</p></>
          )}
        </section>
      ) : (
        queue.map((entry) => <ReviewCard key={entry.jobId} entry={entry} manual={manual} />)
      )}

      {skipped.length > 0 ? (
        <section className="panel" aria-label="Skipped postings">
          <h2>Skipped postings</h2>
          <ul className="fact-list">{skipped.map((feedback) => {
            return <li key={feedback.jobId}>
              <strong>{feedback.title}</strong> · {feedback.reason}
              {feedback.preferenceNote ? <p>Preference note: {feedback.preferenceNote}</p> : null}
              <form action={restoreReviewJobAction}><input type="hidden" name="jobId" value={feedback.jobId} /><button className="review-button" type="submit">Restore to queue</button></form>
            </li>;
          })}</ul>
        </section>
      ) : null}
    </div>
  );
}
