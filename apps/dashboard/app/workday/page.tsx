import { listWorkdaySites } from "@internship-agent/agent";

import { WorkdaySiteRow } from "@/components/workday/WorkdaySiteRow";
import { getActiveDatabase } from "@/lib/active-profile";

export const dynamic = "force-dynamic";

export default async function WorkdayAccountsPage() {
  const database = await getActiveDatabase();
  const sites = listWorkdaySites(database);
  const connected = sites.filter((site) => site.session?.status === "connected").length;
  const waiting = sites.reduce((total, site) => total + site.applications, 0);

  return (
    <div className="page-stack">
      <header className="page-header compact-header">
        <div>
          <h1>Workday accounts</h1>
          <p>Each employer&apos;s Workday site has its own account. Sign in yourself; the agent never sees your password.</p>
        </div>
      </header>

      <section className="metric-grid" aria-label="Workday summary">
        <article className="metric-card"><span>Sites</span><strong>{sites.length}</strong><small>with applications waiting</small></article>
        <article className="metric-card"><span>Connected</span><strong>{connected}</strong><small>signed in this browser</small></article>
        <article className="metric-card"><span>Applications</span><strong>{waiting}</strong></article>
      </section>

      {sites.length === 0 ? (
        <section className="panel empty-state">
          <h3>No Workday applications waiting</h3>
          <p>Prepared applications on Workday career sites appear here.</p>
        </section>
      ) : (
        <section className="panel" aria-label="Workday sites">
          <ul className="fact-list workday-sites">
            {sites.map((site) => <WorkdaySiteRow key={site.siteKey} site={site} />)}
          </ul>
        </section>
      )}
    </div>
  );
}
