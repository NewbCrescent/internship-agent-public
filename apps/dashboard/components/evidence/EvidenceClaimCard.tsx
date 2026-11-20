import type { EvidenceClaim } from "@internship-agent/domain";

import { ClaimReviewControls } from "./ClaimReviewControls";

export function EvidenceClaimCard({ claim }: { claim: EvidenceClaim }) {
  return (
    <article className={`claim-card ${claim.freshness === "STALE" ? "stale" : ""}`}>
      <div className="claim-heading">
        <div>
          <span className="claim-kind">{claim.kind}</span>
          <strong>{claim.text}</strong>
        </div>
        <div className="claim-badges">
          <span className={`review-status status-${claim.reviewStatus.toLowerCase()}`}>{claim.reviewStatus}</span>
          {claim.freshness === "STALE" ? <span className="review-status status-stale">STALE</span> : null}
        </div>
      </div>
      <div className="evidence-list">
        {claim.evidence.map((evidence) => (
          <blockquote key={evidence.id}>
            <p>{evidence.excerpt}</p>
            <a href={evidence.locator.sourceUrl} target="_blank" rel="noreferrer">
              {evidence.locator.path}:{evidence.locator.startLine}
              {evidence.locator.endLine === evidence.locator.startLine ? "" : `–${evidence.locator.endLine}`}
            </a>
          </blockquote>
        ))}
      </div>
      {claim.freshness === "CURRENT" ? <ClaimReviewControls claimId={claim.id} /> : (
        <p className="stale-note">Source changed or disappeared. Re-sync before this claim can be used.</p>
      )}
    </article>
  );
}
