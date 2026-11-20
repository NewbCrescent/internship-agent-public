import { getCandidateWorkspace } from "@internship-agent/agent";
import { getGitHubEvidenceWorkspace } from "@internship-agent/github";

import { EvidenceClaimCard } from "@/components/evidence/EvidenceClaimCard";
import { RepositorySyncForm } from "@/components/evidence/RepositorySyncForm";
import { getActiveDatabase } from "@/lib/active-profile";

export const dynamic = "force-dynamic";

export default async function EvidencePage() {
  const database = await getActiveDatabase();
  const candidate = getCandidateWorkspace(database).candidate;
  const workspace = getGitHubEvidenceWorkspace(database);
  const allClaims = workspace.projects.flatMap((project) => project.claims);
  const verifiedClaims = allClaims.filter((claim) => claim.reviewStatus === "ALLOWED" && claim.freshness === "CURRENT");
  const pendingClaims = allClaims.filter((claim) => claim.reviewStatus === "PENDING" && claim.freshness === "CURRENT");
  const repositoriesById = new Map(workspace.repositories.map((repository) => [repository.id, repository]));

  return (
    <div className="page-stack">
      <header className="page-header compact-header">
        <div>
          <h1>GitHub evidence</h1>
          <p>Claims stay unused until you allow them.</p>
        </div>
      </header>

      {!candidate ? (
        <div className="warning-banner">Create the local candidate in Profile or run <code>pnpm seed:dev</code> before syncing a repository.</div>
      ) : <RepositorySyncForm />}

      <section className="metric-grid" aria-label="Evidence summary">
        <article className="metric-card"><span>Repositories</span><strong>{workspace.repositories.length}</strong></article>
        <article className="metric-card"><span>Awaiting review</span><strong>{pendingClaims.length}</strong><small>excluded until allowed</small></article>
        <article className="metric-card"><span>Verified claims</span><strong>{verifiedClaims.length}</strong><small>allowed and current</small></article>
      </section>

      {workspace.repositories.length > 0 ? (
        <section className="repository-strip" aria-label="Repository sync state">
          {workspace.repositories.map((repository) => (
            <article key={repository.id}>
              <div><strong>{repository.owner}/{repository.name}</strong><span>{repository.defaultBranch} · {repository.analyzedHeadSha?.slice(0, 7) ?? "not analyzed"}</span></div>
              <span className={`review-status status-${repository.syncStatus.toLowerCase()}`}>{repository.syncStatus}</span>
              {repository.lastError ? <p>{repository.lastError}</p> : null}
            </article>
          ))}
        </section>
      ) : null}

      {workspace.projects.length === 0 ? (
        <section className="panel empty-state">
          <h3>No repository evidence yet</h3>
          <p>Sync a repository to review its claims.</p>
        </section>
      ) : workspace.projects.map((project) => {
        const repository = repositoriesById.get(project.repositoryId);
        const allowed = project.claims.filter((claim) => claim.reviewStatus === "ALLOWED" && claim.freshness === "CURRENT");
        return (
          <section className="panel project-evidence" key={project.id}>
            <div className="section-heading">
              <div><h2>{project.name}</h2></div>
              <span className="pill">{allowed.length} verified</span>
            </div>
            {project.summary ? <p className="project-summary">{project.summary}</p> : null}
            {repository ? <a className="repository-link" href={repository.url} target="_blank" rel="noreferrer">Open repository ↗</a> : null}
            <div className="claim-list">
              {project.claims.map((claim) => <EvidenceClaimCard claim={claim} key={claim.id} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
