import Link from "next/link";

import { getPipelineCounts, listRecentEvents } from "@internship-agent/agent";
import { getDashboardJobsPage } from "@internship-agent/jobs";

import { AutoRefresh } from "@/components/overview/AutoRefresh";
import { getActiveDatabase } from "@/lib/active-profile";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const database = await getActiveDatabase();
  const { jobs, total } = getDashboardJobsPage(database, {}, 20);
  const counts = getPipelineCounts(database);
  const count = (status: string) => counts[status] ?? 0;
  const active = count("DISCOVERED") + count("ANALYZING") + count("QUALIFIED") + count("PREPARING");
  const waiting = count("READY_FOR_REVIEW") + count("NEEDS_INPUT");
  const submitted = count("SUBMITTED") + count("APPLYING") + count("APPROVED");
  const events = listRecentEvents(8, database);

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>Overview</h1>
        </div>
        <Link className="secondary-button" href="/profile">Edit profile</Link>
      </header>

      <AutoRefresh />
      <section className="metric-grid" aria-label="Pipeline summary">
        <article className="metric-card"><span>In pipeline</span><strong>{active}</strong><small>discovered → preparing</small></article>
        <article className="metric-card"><span>Waiting on you</span><strong>{waiting}</strong><small>review or input</small></article>
        <article className="metric-card"><span>Approved & submitted</span><strong>{submitted}</strong></article>
      </section>

      <section className="panel" aria-label="Recent agent activity">
        <div className="section-heading">
          <div><h2>Recent activity</h2></div>
          <Link className="pill" href="/review">Open Review Queue</Link>
        </div>
        {events.length === 0 ? (
          <p className="form-help">No activity yet. Analyze a posting in <Link href="/jobs">Jobs</Link> to start.</p>
        ) : (
          <ol className="event-timeline">
            {events.map((event) => (
              <li key={event.id}>
                <strong>{event.companyName} — {event.title}</strong>
                <span>{event.fromStatus?.toLocaleLowerCase("en-US") ?? "—"} → {event.toStatus.toLocaleLowerCase("en-US")} · {new Date(event.createdAt).toLocaleString("en-US")}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div><h2>Recent postings</h2><p>Latest {jobs.length} of {total}</p></div>
          <Link className="pill" href="/jobs">Open Jobs</Link>
        </div>
        {jobs.length === 0 ? (
          <div className="empty-state">
            <h3>No postings yet</h3>
            <p>Paste a posting in <Link href="/jobs">Jobs</Link>, or run <code>pnpm seed:dev</code>.</p>
          </div>
        ) : (
          <div className="job-list">
            {jobs.map((job) => (
              <article className="job-row" key={job.id}>
                <div>
                  <strong>{job.title}</strong>
                  <span>{job.companyName} · {job.primaryLocation} · {job.hardRequirementCount} hard requirements</span>
                </div>
                <span className="status-badge">{job.status.toLocaleLowerCase("en-US")}</span>
              </article>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}
