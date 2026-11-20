import type { JobRequirement } from "@internship-agent/domain";

export function RequirementList({
  requirements,
  category,
  emptyNote
}: {
  requirements: JobRequirement[];
  category: JobRequirement["category"];
  emptyNote: string;
}) {
  const matching = requirements.filter((requirement) => requirement.category === category);
  return (
    <div className="requirement-group">
      <h3>
        {category === "HARD" ? "Hard requirements" : "Preferred qualifications"}
        <span className="pill">{matching.length}</span>
      </h3>
      {matching.length === 0 ? <p className="stale-note">{emptyNote}</p> : (
        <ul className="requirement-list">
          {matching.map((requirement) => (
            <li key={requirement.id}>
              <div className="requirement-heading">
                <strong>{requirement.text}</strong>
                <span className="claim-kind">{requirement.subject.toLocaleLowerCase("en-US")}</span>
              </div>
              <div className="requirement-meta">
                <span className={`review-status status-${requirement.assertion.toLowerCase()}`}>
                  {requirement.assertion}
                </span>
                {requirement.extraction === "MODEL" ? <span>model-classified</span> : null}
                <span title="How sure the reading of this posting line is. It says nothing about whether you meet the requirement.">
                  reading confidence {Math.round(requirement.confidence * 100)}%
                </span>
                <span className="span-note" title="Where this quote sits in the stored posting snapshot">
                  {requirement.span.excerpt === requirement.text ? "verbatim, " : ""}chars {requirement.span.start}–{requirement.span.end}
                </span>
              </div>
              {/*
                For a bullet the requirement text is the excerpt itself, so the
                quote would just repeat it. Only show the source line when it
                adds something the requirement text does not already say.
              */}
              {requirement.span.excerpt === requirement.text ? null : (
                <blockquote><p>{requirement.span.excerpt}</p></blockquote>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
