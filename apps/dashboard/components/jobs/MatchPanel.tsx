import type { JobMatchReport, SemanticFitAssessment } from "@internship-agent/domain";

import { AiFitButton } from "./AiFitButton";
import { analyzePostingAction } from "@/app/jobs/actions";

const VERDICT_LABELS: Record<JobMatchReport["verdict"], string> = {
  QUALIFIED: "Qualified",
  NOT_QUALIFIED: "Not qualified",
  NEEDS_REVIEW: "Needs review"
};

export function MatchPanel({ jobId, match, semantic: semanticProp }: { jobId: string; match: (JobMatchReport & { heuristicFitScore?: number; aiFailure?: string | null; semantic?: { assessment: SemanticFitAssessment; stale: boolean } | null }) | null; semantic?: { assessment: SemanticFitAssessment; stale: boolean } | null }) {
  const semantic = semanticProp ?? match?.semantic ?? null;
  const judgment = semantic?.assessment.version === 2 ? semantic.assessment : null;
  if (!match) {
    return (
      <div className="match-panel">
        <form action={analyzePostingAction}>
          <input type="hidden" name="jobId" value={jobId} />
          <p className="form-help">No eligibility analysis yet.</p>
          <button className="primary-button" type="submit">Analyze eligibility and fit</button>
        </form>
        {semantic ? <AiAssessment jobId={jobId} semantic={semantic} judgment={judgment} aiFailure={null} /> : null}
      </div>
    );
  }
  const failures = match.findings.filter((finding) => finding.outcome === "FAIL");
  return (
    <div className="match-panel">
      <div className="section-heading">
        <div>
          <h3>Eligibility: {VERDICT_LABELS[match.verdict]}{judgment && !semantic?.stale ? ` · AI competitiveness ${judgment.score}/100` : ""}</h3>
        </div>
        <form action={analyzePostingAction}>
          <input type="hidden" name="jobId" value={jobId} />
          <button className="review-button" type="submit">Re-analyze</button>
        </form>
      </div>
      {failures.length > 0 ? (
        <ul className="finding-list failures" aria-label="Failed requirements">
          {failures.map((finding, index) => (
            <li key={`${finding.subject}-${index}`}>
              <strong>{finding.subject}</strong>: {finding.reason}
              {finding.statedExcerpt ? <blockquote>{finding.statedExcerpt}</blockquote> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="form-help">No hard requirements failed.</p>
      )}
      <AiAssessment jobId={jobId} semantic={semantic} judgment={judgment} aiFailure={match.aiFailure ?? null} />
      <details><summary>Secondary keyword estimate: {match.heuristicFitScore ?? match.fitScore}/100</summary>
      <ul className="reason-list" aria-label="Fit reasons">
        {match.reasons.map((reason) => (
          <li key={reason.factor}>
            <strong>{reason.factor}</strong> ({reason.delta >= 0 ? "+" : ""}{reason.delta}): {reason.detail}
          </li>
        ))}
      </ul>
      </details>
      {unknownCount(match) > 0 ? (
        <p className="unknown-note">
          {unknownCount(match)} {unknownCount(match) === 1 ? "check needs" : "checks need"} your input before this verdict is final.
        </p>
      ) : null}
    </div>
  );
}

function unknownCount(match: JobMatchReport): number {
  return match.findings.filter((finding) => finding.outcome === "UNKNOWN").length;
}

function AiAssessment({ jobId, semantic, judgment, aiFailure }: {
  jobId: string;
  semantic: { assessment: SemanticFitAssessment; stale: boolean } | null;
  judgment: Extract<SemanticFitAssessment, { version: 2 }> | null;
  aiFailure: string | null;
}) {
  return (
    <>
      <AiFitButton jobId={jobId} />
      {judgment ? <section aria-label="AI fit assessment">
        {semantic?.stale ? <p className="unknown-note">Out of date: its inputs changed, so it isn&apos;t used for ranking.</p> : null}
        <p><strong>{judgment.rating === "INSUFFICIENT_INFORMATION" ? "Insufficient information" : `${judgment.rating.toLocaleLowerCase("en-US")} competitiveness`}</strong> · {judgment.confidence.toLocaleLowerCase("en-US")} assessment confidence</p>
        <p>{judgment.summary}</p>
        <p className="unknown-note">An AI estimate, not a hiring probability.</p>
        <details><summary>Strengths, gaps, and evidence</summary>
          <h4>Strengths</h4>
          <ul className="reason-list">{judgment.strengths.map((point, index) => <li key={index}>{point.text}
            <blockquote>{point.postingQuote}<small>Job description</small></blockquote>
            {point.citations.map((citation, i) => <blockquote key={i}>{citation.quote}<small>Source: {citation.evidenceId}</small></blockquote>)}
          </li>)}</ul>
          <h4>Gaps</h4>
          <ul className="reason-list">{judgment.gaps.map((point, index) => <li key={index}>{point.text}
            <blockquote>{point.postingQuote}<small>Job description</small></blockquote>
            {point.citations.map((citation, i) => <blockquote key={i}>{citation.quote}<small>Source: {citation.evidenceId}</small></blockquote>)}
          </li>)}</ul>
          <h4>Uncertainty</h4><ul>{judgment.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul>
        </details>
      </section> : <p className="form-help">{aiFailure ? "AI assessment failed. You can retry." : "No AI assessment yet."}</p>}
    </>
  );
}
