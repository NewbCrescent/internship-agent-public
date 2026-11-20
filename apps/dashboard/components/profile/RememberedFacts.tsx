import { factDefinitions, formatFactValue, type CandidateFact } from "@internship-agent/domain";

import { forgetFactAction } from "@/app/profile/actions";

export function RememberedFacts({ facts }: { facts: CandidateFact[] }) {
  return (
    <section className="panel">
      <div className="section-heading"><div><h2>Remembered answers</h2></div><span className="pill">{facts.length} active</span></div>
      {facts.length === 0 ? (
        <div className="empty-state"><h3>No remembered answers yet</h3><p>Answer a question above to add one.</p></div>
      ) : (
        <div className="fact-list">
          {facts.map((fact) => (
            <article className="fact-row" key={fact.id}>
              <div className="fact-primary">
                <span className="fact-icon">{fact.sensitivity === "sensitive" || fact.sensitivity === "protected" ? "!" : "✓"}</span>
                <div><strong>{factDefinitions[fact.key].label}</strong><span>{scopeLabel(fact)} · {fact.sourceDetail.question ?? fact.sourceDetail.kind}</span></div>
              </div>
              {/* Protected self-identification answers are never shown on screen; Forget still revokes them. */}
              <div className="fact-value"><strong>{fact.sensitivity === "protected" ? "Saved" : formatFactValue(fact.value)}</strong><small>{fact.sensitivity}</small></div>
              <form action={forgetFactAction.bind(null, fact.id)}><button className="text-button" type="submit">Forget</button></form>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function scopeLabel(fact: CandidateFact): string {
  if (fact.scope.kind === "global") return "Global scope";
  if (fact.scope.kind === "country") return fact.scope.code;
  if (fact.scope.kind === "application_channel") return "2029 profile: Handshake Quick Apply / Apply, or applications asking for a transcript";
  if (fact.scope.kind === "company") return `Only at ${fact.scope.name}`;
  return fact.scope.name;
}
