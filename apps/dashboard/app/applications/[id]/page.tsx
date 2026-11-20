import Link from "next/link";
import { notFound } from "next/navigation";

import {
  applicationUrlFor,
  canStartBrowserRun,
  resumeChangedSincePrepared,
  getApplicationPackage,
  getBrowserRuns,
  getMatchReport,
  getResumeVariantUsage,
  getJobOutcomeEvents,
  listJobEvents,
  listJobResumeVariants
} from "@internship-agent/agent";
import { manualOnly } from "@internship-agent/domain";
import { getPosting } from "@internship-agent/jobs";

import { BrowserRunPanel } from "@/components/applications/BrowserRunPanel";
import { refreshResumeAction } from "@/app/review/actions";
import { OutcomeActions } from "@/components/applications/OutcomeActions";
import { ReviewActions } from "@/components/applications/ReviewActions";
import { VerificationChecks } from "@/components/applications/VerificationChecks";
import { getActiveDatabase } from "@/lib/active-profile";

export const dynamic = "force-dynamic";

export default async function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const database = await getActiveDatabase();
  const posting = getPosting(id, database);
  if (!posting) notFound();
  const match = getMatchReport(id, database);
  const application = getApplicationPackage(id, database);
  const resumeChanged = ["READY_FOR_REVIEW", "NEEDS_INPUT", "APPROVED", "APPLYING"].includes(posting.status)
    && resumeChangedSincePrepared(id, database);
  const events = listJobEvents(id, database);
  const outcomeEvents = getJobOutcomeEvents(id, database);
  const variants = listJobResumeVariants(id, database);
  const variantUse = new Map(getResumeVariantUsage(id, database).map((use) => [use.variantId, use]));
  const runs = getBrowserRuns(id, database);
  const verification = application?.verification ?? null;
  const applicationUrl = applicationUrlFor(posting.source) ?? "";

  return (
    <div className="page-stack">
      <header className="page-header compact-header">
        <div>
          <p className="eyebrow">{posting.companyName}</p>
          <h1>{posting.title}</h1>
          <p>
            <span className="status-badge">{posting.status.toLocaleLowerCase("en-US")}</span>
            {match ? <> · fit {match.fitScore}/100 · {match.verdict.toLocaleLowerCase("en-US").replace("_", " ")}</> : null}
          </p>
          {resumeChanged ? (
            <form action={refreshResumeAction} className="resume-changed">
              <span className="status-badge">Resume changed since prepared</span>
              <input type="hidden" name="jobIds" value={posting.id} />
              <button className="text-button" type="submit">Refresh with current resume</button>
            </form>
          ) : null}
        </div>
        <Link className="pill" href="/applications">All applications</Link>
      </header>

      <section className="panel" aria-label="Sources and links">
        <div className="section-heading"><div><h2>Sources</h2></div></div>
        <div className="posting-links">
          <a href={posting.source.sourceUrl} target="_blank" rel="noreferrer">Source posting ↗</a>
          {posting.source.externalApplicationUrl ? (
            <a href={posting.source.externalApplicationUrl} target="_blank" rel="noreferrer">External application ↗</a>
          ) : null}
          {posting.source.companyCareersUrl ? (
            <a href={posting.source.companyCareersUrl} target="_blank" rel="noreferrer">Careers page ↗</a>
          ) : null}
        </div>
        <details>
          <summary>Stored job description snapshot</summary>
          <pre className="snapshot-text">{posting.snapshot.normalizedText}</pre>
        </details>
      </section>

      {application ? (
        <section className="panel" aria-label="Application materials">
          <div className="section-heading">
            <div><h2>Package</h2></div>
            <span className="pill">{verification?.blocked === false ? "verified" : verification ? "blocked" : "unverified"}</span>
          </div>
          <p>{application.package.summary}</p>
          {application.package.answers.map((answer) => (
            <article key={answer.id} className="answer-block">
              <h4>{answer.prompt}</h4>
              <p>{answer.text}</p>
            </article>
          ))}
          <ul className="bullet-list" aria-label="Resume bullets">
            {application.package.bullets.map((bullet) => <li key={bullet.id}>{bullet.text}</li>)}
          </ul>
          {verification ? <VerificationChecks report={verification} claims={application.package.claims} /> : null}
        </section>
      ) : (
        <section className="panel empty-state">
          <h3>No package prepared</h3>
          <p>Analyze and prepare this posting from <Link href="/jobs">Jobs</Link>.</p>
        </section>
      )}

      {variants.length > 0 ? (
        <section className="panel" aria-label="Resume variants">
          <div className="section-heading"><div><h2>Resume variants</h2></div></div>
          {variants.map((variant) => {
            const use = variantUse.get(variant.id);
            return (
              <details key={variant.id} data-testid="resume-variant">
                <summary>
                  {variant.label} · {new Date(variant.createdAt).toLocaleString("en-US")}
                  {use ? <span className={use.used ? "pill" : "pill muted-pill"}>{use.label}</span> : null}
                </summary>
                <p><a href={`/applications/${posting.id}/variants/${variant.id}`} rel="noreferrer" target="_blank">View PDF</a></p>
                <ul className="bullet-list">
                  {variant.bullets.map((bullet) => <li key={bullet.id}>{bullet.text}</li>)}
                </ul>
              </details>
            );
          })}
        </section>
      ) : null}

      <section className="panel" aria-label="Event timeline">
        <div className="section-heading"><div><h2>Timeline</h2></div></div>
        {events.length === 0 ? (
          <p className="form-help">No activity yet.</p>
        ) : (
          <ol className="event-timeline">
            {events.map((event) => (
              <li key={event.id}>
                <strong>{event.fromStatus?.toLocaleLowerCase("en-US") ?? "—"} → {event.toStatus.toLocaleLowerCase("en-US")}</strong>
                <span>{new Date(event.createdAt).toLocaleString("en-US")}</span>
                {event.detail ? <p>{event.detail}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {outcomeEvents.length > 0 ? (
        <section className="panel" aria-label="Detailed employer outcomes">
          <h2>Employer updates</h2>
          <ol className="event-timeline">{outcomeEvents.map((event) => <li key={event.id}>
            <strong>{event.stage.toLocaleLowerCase("en-US")}</strong>
            <span>{new Date(event.recordedAt).toLocaleString("en-US")}</span>
            {event.note ? <p>{event.note}</p> : null}
          </li>)}</ol>
        </section>
      ) : null}

      <BrowserRunPanel jobId={posting.id} status={posting.status} defaultUrl={applicationUrl} runs={runs} canStart={canStartBrowserRun(posting.id, database)} manualOnly={manualOnly()} />

      <ReviewActions jobId={posting.id} status={posting.status} canApprove={posting.status === "READY_FOR_REVIEW"} manualOnly={manualOnly()} />
      {posting.status === "SUBMITTED" || posting.status === "INTERVIEW" ? (
        <OutcomeActions jobId={posting.id} />
      ) : null}
    </div>
  );
}
