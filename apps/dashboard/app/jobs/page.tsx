import { getApplicationPackage, getDiscoveryRuns, getDiscoverySources, getMatchReport, readPipelineLock } from "@internship-agent/agent";
import { getSemanticFit } from "@internship-agent/db";
import { countryName } from "@internship-agent/domain";
import { getJobListPage, getPosting, JOBS_PER_PAGE, parseJobListOptions } from "@internship-agent/jobs";

import { BatchPostingForm } from "@/components/jobs/BatchPostingForm";
import { CompanySourceForm } from "@/components/jobs/CompanySourceForm";
import { JobCardControls } from "@/components/jobs/JobCardControls";
import { JobPostingCard } from "@/components/jobs/JobPostingCard";
import { PostingIngestForm } from "@/components/jobs/PostingIngestForm";
import { getActiveDatabase, getActiveDataDirectory } from "@/lib/active-profile";

export const dynamic = "force-dynamic";

export default async function JobsPage({ searchParams }: {
  searchParams: Promise<{ sort?: string | string[]; category?: string | string[]; page?: string | string[]; days?: string | string[]; country?: string | string[]; minPay?: string | string[] }>;
}) {
  const database = await getActiveDatabase();
  const pipeline = readPipelineLock(await getActiveDataDirectory());
  const listOptions = parseJobListOptions(await searchParams);
  // Sorting uses lightweight summaries (cached until postings change); full
  // postings, reports, and packages load only for the current page.
  const list = getJobListPage(database, listOptions);
  const postings = list.ids.map((jobId) => getPosting(jobId, database)).filter((posting) => posting !== null);
  const matches = new Map(postings.map((posting) => [posting.id, getMatchReport(posting.id, database)]));
  const semantics = new Map(postings.map((posting) => [posting.id, getSemanticFit(database, posting.id)]));
  const applications = new Map(postings.map((posting) => [posting.id, getApplicationPackage(posting.id, database)]));
  const runs = getDiscoveryRuns(5, database);

  return (
    <div className="page-stack">
      <header className="page-header compact-header">
        <div>
          <h1>Jobs</h1>
        </div>
      </header>

      <PostingIngestForm />
      <BatchPostingForm />
      <CompanySourceForm sources={getDiscoverySources(database)} pipelineStartedAt={pipeline?.startedAt ?? null} />

      <section className="metric-grid" aria-label="Posting summary">
        <article className="metric-card"><span>Postings</span><strong>{list.total}</strong></article>
        <article className="metric-card"><span>Hard requirements</span><strong>{list.stats.hardRequirements}</strong></article>
        <article className="metric-card"><span>With constraints</span><strong>{list.stats.constrained}</strong><small>state eligibility rules</small></article>
      </section>

      {list.total === 0 ? (
        <section className="panel empty-state">
          <h3>No postings yet</h3>
          <p>Paste a posting above, or run <code>pnpm seed:dev</code> for the fictional example.</p>
        </section>
      ) : (
        <p className="match-summary" aria-label="Match summary">
          {list.stats.qualified} of {list.total} analyzed {list.total === 1 ? "posting is" : "postings are"} qualified.
        </p>
      )}
      {list.total > 0 ? (
        <JobCardControls
          key={`${listOptions.postedWithinDays ?? "all"}|${listOptions.minHourlyPay ?? ""}`}
          sort={listOptions.sort}
          postedWithinDays={listOptions.postedWithinDays ?? null}
          unknownDates={list.unknownDates}
          category={listOptions.category}
          categories={list.categories}
          country={listOptions.country ?? null}
          minHourlyPay={listOptions.minHourlyPay ?? null}
          countries={list.countries.countries.map((entry) => ({ ...entry, name: countryName(entry.code) }))}
          unstatedCountries={list.countries.unstated}
          unstated={list.unstated}
          page={list.page}
          pageCount={list.pageCount}
          pageSize={JOBS_PER_PAGE}
          filtered={list.filtered}
          total={list.total}
        />
      ) : null}
      {list.total > 0 && list.filtered === 0 ? <section className="panel empty-state"><h3>No postings match these filters</h3><p>Try a longer posting window or clear the filters.</p></section> : null}
      {postings.map((posting) => (
        <JobPostingCard
          key={posting.id}
          posting={posting}
          match={matches.get(posting.id) ?? null}
          semantic={semantics.get(posting.id) ?? null}
          application={applications.get(posting.id) ?? null}
        />
      ))}
      <DiscoveryRuns runs={runs} />
    </div>
  );
}

function DiscoveryRuns({ runs }: { runs: ReturnType<typeof getDiscoveryRuns> }) {
  if (runs.length === 0) return null;
  return (
    <section className="panel" aria-label="Discovery runs">
      <div className="section-heading">
        <div>
          <h2>Recent discovery runs</h2>
        </div>
      </div>
      <ul className="fact-list">
        {runs.map((run) => (
          <li key={run.id}>
            {new Date(run.startedAt).toLocaleString()} — {run.fetched} fetched, {run.deduped} duplicates,{" "}
            {run.ingested} ingested, {run.analyzed} analyzed, {run.promoted} promoted
          </li>
        ))}
      </ul>
    </section>
  );
}
