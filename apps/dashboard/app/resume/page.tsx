import Link from "next/link";

import { getCandidateWorkspace, listCandidateResumeEntries } from "@internship-agent/agent";
import type { ResumeEntry, ResumeSection } from "@internship-agent/domain";

import { ResumeEntryForm } from "@/components/resume/ResumeEntryForm";
import { getActiveDatabase } from "@/lib/active-profile";

import { approveResumeEntryAction, archiveResumeEntryAction, moveResumeEntryAction, setResumeEntryInWorkHistoryAction, setResumeEntryOnResumeAction } from "./actions";

export const dynamic = "force-dynamic";

const SECTIONS: Array<{ section: ResumeSection; title: string }> = [
  { section: "experience", title: "Professional Experience" },
  { section: "project", title: "Projects" },
  { section: "skills", title: "Technical Skills" }
];

export default async function ResumePage() {
  const database = await getActiveDatabase();
  const { candidate } = getCandidateWorkspace(database);
  const entries = candidate ? listCandidateResumeEntries(database) : [];
  const pending = entries.filter((entry) => entry.current.reviewStatus === "PENDING").length;

  return (
    <div className="page-stack">
      <header className="page-header compact-header">
        <div>
          <h1>Resume</h1>
          <p>Approved entries print in this order, word for word.</p>
        </div>
        {candidate ? <Link className="secondary-button" href="/resume/preview" target="_blank">Preview PDF</Link> : null}
      </header>

      {!candidate ? (
        <div className="warning-banner">Create the profile on <Link href="/profile">Profile & Memory</Link> before adding resume entries.</div>
      ) : (
        <>
          {pending > 0 ? (
            <div className="warning-banner" data-testid="pending-resume-entries">
              {pending} {pending === 1 ? "entry waits" : "entries wait"} for your approval. Only approved entries print.
            </div>
          ) : null}
          <section className="panel form-panel">
            <div className="section-heading"><div><h2>Add to your resume</h2></div><span className="pill">Approved on save</span></div>
            <ResumeEntryForm />
          </section>
          {SECTIONS.map(({ section, title }) => (
            <ResumeSectionPanel key={section} title={title} entries={entries.filter((entry) => entry.section === section)} />
          ))}
        </>
      )}
    </div>
  );
}

function ResumeSectionPanel({ title, entries }: { title: string; entries: ResumeEntry[] }) {
  return (
    <section className="panel" aria-label={title}>
      <div className="section-heading"><div><h2>{title}</h2></div><span className="pill">{entries.filter((entry) => entry.onResume).length} of {entries.length} on resume</span></div>
      {entries.length === 0 ? <p className="form-help">No entries yet.</p> : (
        <div className="fact-list">
          {entries.map((entry, index) => <ResumeEntryCard key={entry.id} entry={entry} first={index === 0} last={index === entries.length - 1} />)}
        </div>
      )}
    </section>
  );
}

function ResumeEntryCard({ entry, first, last }: { entry: ResumeEntry; first: boolean; last: boolean }) {
  const revision = entry.current;
  const place = [revision.location, revision.dateText].filter(Boolean).join(" ");
  const pending = revision.reviewStatus === "PENDING";
  return (
    <article className="resume-entry" data-testid="resume-entry">
      <div className="resume-entry-head">
        <div>
          <strong>{revision.title}</strong>{revision.role ? <> | {revision.role}</> : null}
          {revision.linkUrl ? <> (<a href={revision.linkUrl} rel="noreferrer" target="_blank">{revision.linkLabel ?? revision.linkUrl}</a>)</> : null}
          {place ? <span className="resume-entry-meta">{place}</span> : null}
        </div>
        <span className="resume-entry-badges">
          <span className={entry.onResume ? "pill" : "pill pill-muted"}>{entry.onResume ? "On resume" : "Library only"}</span>
          {entry.section === "experience" && entry.inWorkHistory ? <span className="pill">In application work history</span> : null}
          <span className={pending ? "status-badge" : "pill"}>{pending ? "Pending your approval" : "Approved"}</span>
        </span>
      </div>
      {entry.section === "skills"
        ? <p>{revision.bullets.join(", ")}</p>
        : <ul className="bullet-list">{revision.bullets.map((bullet, index) => <li key={index}>{bullet}</li>)}</ul>}
      <p className="form-help">{revision.source.kind === "user" ? "Typed by you." : `From your base resume (sha256 ${revision.source.sha256.slice(0, 12)}…).`}</p>
      <div className="resume-entry-actions">
        {pending ? (
          <form action={approveResumeEntryAction}>
            <input type="hidden" name="entryId" value={entry.id} />
            <input type="hidden" name="revisionId" value={revision.id} />
            <button className="primary-button" type="submit">Approve</button>
          </form>
        ) : null}
        <form action={moveResumeEntryAction}>
          <input type="hidden" name="entryId" value={entry.id} />
          <button className="text-button" type="submit" name="direction" value="up" disabled={first}>Move up</button>
          <button className="text-button" type="submit" name="direction" value="down" disabled={last}>Move down</button>
        </form>
        <form action={setResumeEntryOnResumeAction}>
          <input type="hidden" name="entryId" value={entry.id} />
          <input type="hidden" name="onResume" value={entry.onResume ? "false" : "true"} />
          <button className="text-button" type="submit">{entry.onResume ? "Leave off resume" : "Put on resume"}</button>
        </form>
        {entry.section === "experience" ? (
          <form action={setResumeEntryInWorkHistoryAction}>
            <input type="hidden" name="entryId" value={entry.id} />
            <input type="hidden" name="inWorkHistory" value={entry.inWorkHistory ? "false" : "true"} />
            <button className="text-button" type="submit">{entry.inWorkHistory ? "Remove from work history" : "Add to work history"}</button>
          </form>
        ) : null}
        <form action={archiveResumeEntryAction}>
          <input type="hidden" name="entryId" value={entry.id} />
          <button className="text-button" type="submit">Archive</button>
        </form>
      </div>
      <details>
        <summary>Edit</summary>
        <ResumeEntryForm entry={entry} />
      </details>
    </article>
  );
}
