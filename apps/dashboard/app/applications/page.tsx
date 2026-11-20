import Link from "next/link";

import { getOutcomeRecommendations, getOutcomeStats } from "@internship-agent/agent";
import { getDashboardJobsPage } from "@internship-agent/jobs";
import { ListPagination } from "@/components/layout/ListPagination";
import { getActiveDatabase } from "@/lib/active-profile";

export const dynamic = "force-dynamic";

const FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "READY_FOR_REVIEW", label: "Ready" },
  { value: "NEEDS_INPUT", label: "Needs input" },
  { value: "APPROVED", label: "Approved" },
  { value: "QUALIFIED", label: "Qualified" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "INTERVIEW", label: "Interview" },
  { value: "OFFER", label: "Offer" },
  { value: "REJECTED", label: "Rejected" },
  { value: "WITHDRAWN", label: "Withdrawn" }
];

function percent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

export default async function ApplicationsPage({
  searchParams
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const params = await searchParams;
  const database = await getActiveDatabase();
  const result = getDashboardJobsPage(database, params);
  const { jobs: visible, status } = result;
  const stats = getOutcomeStats(database);
  const recommendations = getOutcomeRecommendations(database, stats);

  return (
    <div className="page-stack">
      <header className="page-header compact-header">
        <div>
          <h1>Applications</h1>
        </div>
      </header>

      <section className="metric-grid" aria-label="Outcome funnel">
        <article className="metric-card"><span>Submitted</span><strong>{stats.funnel.submitted}</strong></article>
        <article className="metric-card"><span>Interviews</span><strong>{stats.funnel.interview}</strong><small>{percent(stats.interviewRate)} of submitted</small></article>
        <article className="metric-card"><span>Offers</span><strong>{stats.funnel.offer}</strong><small>{percent(stats.offerRate)} of submitted</small></article>
        <article className="metric-card"><span>Response rate</span><strong>{percent(stats.responseRate)}</strong><small>{stats.avgDaysToResponse === null ? "no responses yet" : `avg ${stats.avgDaysToResponse.toFixed(1)} days to response`}</small></article>
      </section>

      <section className="panel" aria-label="Detailed outcome stages">
        <h2>Employer stages</h2>
        <ul className="fact-list stage-list">
          {Object.entries(stats.detailedStages).map(([stage, count]) => <li key={stage}><strong>{stage.toLocaleLowerCase("en-US")}</strong>: {count}</li>)}
        </ul>
      </section>

      <section className="panel" aria-label="Conversion by role type">
        <h2>By role type</h2>
        {stats.byRole.length === 0 ? <p className="form-help">No submissions yet.</p> : null}
        <ul className="fact-list">{stats.byRole.map((row) => <li key={row.roleType}>
          <strong>{row.roleType}</strong>: {row.submitted} submitted, {row.responses} responses, {row.interviews} interviews or better, {row.offers} offers
        </li>)}</ul>
      </section>

      <section className="panel" aria-label="Conversion by submitted resume variant">
        <h2>By submitted resume variant</h2>
        {stats.byVariant.length === 0 ? <p className="form-help">No submissions yet.</p> : null}
        <ul className="fact-list">{stats.byVariant.map((row) => <li key={row.variantId ?? "unknown-or-manual"}>
          <strong>{row.variant}</strong>: {row.submitted} submitted, {row.interviews} interviews or better, {row.offers} offers
        </li>)}</ul>
      </section>

      <section className="panel" aria-label="AI cost outcomes">
        <h2>AI cost</h2>
        <p>${stats.cost.knownUsd.toFixed(4)} total{stats.cost.unknownCalls > 0 ? ` · ${stats.cost.unknownCalls} calls with unknown cost` : ""}</p>
        <p className="form-help">Per application {stats.cost.perApplicationUsd === null ? "unknown" : `$${stats.cost.perApplicationUsd.toFixed(4)}`} · per interview {stats.cost.perInterviewUsd === null ? "unknown" : `$${stats.cost.perInterviewUsd.toFixed(4)}`} · per offer {stats.cost.perOfferUsd === null ? "unknown" : `$${stats.cost.perOfferUsd.toFixed(4)}`}</p>
      </section>

      <section className="panel" aria-label="Preference recommendations">
        <h2>Preference suggestions</h2>
        {recommendations.length === 0 ? <p className="form-help">Not enough outcomes yet.</p> : recommendations.map((recommendation) => <p key={recommendation}>{recommendation} <Link href="/profile">Edit preferences</Link></p>)}
      </section>

      <nav className="filter-row" aria-label="Filter by status">
        {FILTERS.map((filter) => (
          <Link
            key={filter.label}
            className={status === filter.value || (!status && !filter.value) ? "pill pill-active" : "pill"}
            href={filter.value ? `/applications?status=${filter.value}` : "/applications"}
          >
            {filter.label}
          </Link>
        ))}
      </nav>

      <ListPagination path="/applications" {...result} />

      {visible.length === 0 ? (
        <section className="panel empty-state">
          <h3>No applications in this state</h3>
          <p>Ingest a posting in <Link href="/jobs">Jobs</Link> to start the pipeline.</p>
        </section>
      ) : (
        <section className="panel" aria-label="Application table">
          {visible.map((job) => (
            <article className="job-row" key={job.id}>
              <div>
                <strong>{job.title}</strong>
                <span>{job.companyName} · {job.primaryLocation} · created {new Date(job.createdAt).toLocaleDateString("en-US")}</span>
              </div>
              <span className="status-badge">{job.status.toLocaleLowerCase("en-US")}</span>
              <Link className="pill" href={`/applications/${job.id}`}>Open detail</Link>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
