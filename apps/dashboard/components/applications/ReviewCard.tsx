import Link from "next/link";

import type { ReviewQueueItem } from "@internship-agent/agent";

import { refreshResumeAction } from "@/app/review/actions";
import { AiFitButton } from "@/components/jobs/AiFitButton";
import { ManualApplyCheck } from "@/components/applications/ManualApplyCheck";
import { QuickSkip } from "@/components/applications/QuickSkip";
import { ReviewActions } from "@/components/applications/ReviewActions";
import { formatPay, postedAgo } from "@/lib/review-facts";

/**
 * One review entry on one line of facts, with the actions that finish it:
 * apply on the employer's site, grab the prepared resume, then mark it applied
 * or skip it with a reason. The title opens the full detail page.
 */
export function ReviewCard({ entry, manual }: { entry: ReviewQueueItem; manual: boolean }) {
  const detail = `/applications/${entry.jobId}`;
  const facts = [
    formatPay(entry.pay),
    entry.primaryLocation ?? "Location not stated",
    postedAgo(entry.postedAt),
    entry.fitScore === null ? "No AI score" : `AI competitiveness ${entry.fitScore}/100`,
    entry.category
  ];
  return (
    <section className="panel review-card" aria-label={`Review ${entry.title}`}>
      <div className="review-card-head">
        <div>
          <p className="eyebrow">{entry.companyName}</p>
          <h2><Link href={detail}>{entry.title}</Link></h2>
          <p className="review-card-facts">{facts.join(" · ")}</p>
        </div>
        {/* In manual mode every waiting entry is "ready for review"; the badge only says something when it differs. */}
        {manual && entry.status === "READY_FOR_REVIEW" && !entry.runStatus ? null : (
          <span className="status-badge">{entry.runStatus
            ? entry.runStatus === "awaiting-approval" ? "filled · awaiting your approval" : "filled · needs your input"
            : entry.status.toLocaleLowerCase("en-US").replaceAll("_", " ")}</span>
        )}
      </div>
      {entry.resumeChanged ? (
        <form action={refreshResumeAction} className="resume-changed">
          <span className="status-badge">Resume changed since prepared</span>
          <input type="hidden" name="jobIds" value={entry.jobId} />
          <button className="text-button" type="submit">Refresh with current resume</button>
        </form>
      ) : null}
      <div className="entry-actions">
        {entry.applicationUrl ? <a className="primary-button" href={entry.applicationUrl} target="_blank" rel="noreferrer">Apply ↗</a> : null}
        {entry.latestVariantId ? (
          <a className="secondary-button" href={`${detail}/variants/${entry.latestVariantId}`} target="_blank" rel="noreferrer">Resume PDF</a>
        ) : null}
        {entry.runStatus ? <Link className="secondary-button" href={detail}>Review filled application</Link> : null}
        {manual && !entry.runStatus ? <ManualApplyCheck jobId={entry.jobId} title={entry.title} /> : null}
        <QuickSkip jobId={entry.jobId} />
        {!manual && entry.status !== "APPLYING" ? (
          <ReviewActions jobId={entry.jobId} status={entry.status}
            canApprove={entry.status === "READY_FOR_REVIEW" && entry.blocked === false} manualOnly={manual} />
        ) : null}
        {entry.fitScore === null ? <AiFitButton jobId={entry.jobId} /> : null}
      </div>
    </section>
  );
}
