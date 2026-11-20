import type { CurrentPackage } from "@internship-agent/agent";
import type { JobMatchReport, JobPosting, SemanticFitAssessment } from "@internship-agent/domain";

import { ApplicationPanel } from "./ApplicationPanel";
import { ConstraintSummary } from "./ConstraintSummary";
import { MatchPanel } from "./MatchPanel";
import { RequirementList } from "./RequirementList";

const APPLICATION_TYPE_LABELS: Record<JobPosting["source"]["applicationType"], string> = {
  HANDSHAKE_INTERNAL: "Handshake application",
  EXTERNAL_ATS: "External ATS",
  EMPLOYER_SITE: "Employer site",
  UNKNOWN: "Unknown application type"
};

export function JobPostingCard({ posting, match, semantic, application }: { posting: JobPosting; match: (JobMatchReport & { semantic?: {assessment: SemanticFitAssessment; stale: boolean} | null }) | null; semantic: { assessment: SemanticFitAssessment; stale: boolean } | null; application: CurrentPackage | null }) {
  return (
    // Collapsed by default; the summary row stays scannable across many postings.
    <details className="panel project-evidence job-card" id={posting.id}>
      <summary className="job-card-summary">
        <div>
          <p className="eyebrow">{posting.companyName}</p>
          <h2>{posting.title}</h2>
          <p className="job-card-meta">
            {posting.publication ? `Posted ${posting.publication.postedAt.slice(0, 10)} · ` : "Date unknown · "}
            {semantic && !semantic.stale ? `AI competitiveness ${semantic.assessment.score}/100 · ` : "No AI score · "}
            {posting.locations.length > 0 ? posting.locations.map((location) => location.raw).join(" · ") : "Location not stated"}
          </p>
        </div>
        <span className="status-badge">{posting.status.toLocaleLowerCase("en-US")}</span>
      </summary>

      <div className="posting-facts">
        <span>{APPLICATION_TYPE_LABELS[posting.source.applicationType]}</span>
        <span>{posting.employmentType.toLocaleLowerCase("en-US").replace("_", " ")}</span>
        <span>
          {posting.locations.length > 0
            ? posting.locations.map((location) => `${location.raw} (${location.workMode.toLocaleLowerCase("en-US")})`).join(" · ")
            : "Location not stated"}
        </span>
        <span>{formatCompensation(posting)}</span>
        {posting.publication ? <a href={posting.publication.sourceUrl} target="_blank" rel="noreferrer">Posted {posting.publication.postedAt.slice(0, 10)} ↗</a> : null}
      </div>

      <div className="posting-links">
        <a href={posting.source.sourceUrl} target="_blank" rel="noreferrer">Source posting ↗</a>
        {posting.source.externalApplicationUrl ? (
          <a href={posting.source.externalApplicationUrl} target="_blank" rel="noreferrer">External application ↗</a>
        ) : null}
        {posting.source.companyCareersUrl ? (
          <a href={posting.source.companyCareersUrl} target="_blank" rel="noreferrer">Careers page ↗</a>
        ) : null}
      </div>

      {posting.technologies.length > 0 ? (
        <div className="technology-strip">
          {posting.technologies.map((technology) => (
            <span className="pill" key={technology.normalizedKey}>{technology.label}</span>
          ))}
        </div>
      ) : null}

      <ConstraintSummary constraints={posting.constraints} />

      <RequirementList
        requirements={posting.requirements}
        category="HARD"
        emptyNote="None stated."
      />
      <RequirementList
        requirements={posting.requirements}
        category="PREFERRED"
        emptyNote="None stated."
      />

      <MatchPanel jobId={posting.id} match={match} semantic={semantic} />

      <ApplicationPanel jobId={posting.id} current={application} />

      <p className="snapshot-note">
        Captured {new Date(posting.snapshot.capturedAt).toLocaleString("en-US")} · {posting.snapshot.contentHash.slice(0, 12)}
      </p>
    </details>
  );
}

function formatCompensation(posting: JobPosting): string {
  const compensation = posting.compensation;
  if (!compensation) return "Compensation not stated";
  if (compensation.period === "STIPEND" && compensation.minimum === null) return "Stipend, amount not stated";
  const period = compensation.period.toLocaleLowerCase("en-US");
  const range = compensation.maximum !== null && compensation.maximum !== compensation.minimum
    ? `${format(compensation.minimum)}–${format(compensation.maximum)}`
    : format(compensation.minimum);
  return `${range} per ${period}`;
}

function format(amount: number | null): string {
  return amount === null ? "?" : `$${amount.toLocaleString("en-US")}`;
}
