import type { ApplicationPackage, ClaimBasis, VerificationReport } from "@internship-agent/domain";

const GROUPS: Record<ClaimBasis["kind"], { one: string; many: string }> = {
  resume_entry: { one: "resume line", many: "resume lines" },
  posting: { one: "posting quote", many: "posting quotes" },
  fact: { one: "saved answer", many: "saved answers" },
  evidence: { one: "evidence claim", many: "evidence claims" },
  presentation: { one: "presentation sentence", many: "presentation sentences" }
};

/**
 * The verifier's report, readable: a one-line summary by statement type,
 * any failing checks first with the statement they checked, and the full
 * list folded away.
 */
export function VerificationChecks({ report, claims }: { report: VerificationReport; claims: ApplicationPackage["claims"] }) {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const rows = report.checks.map((check) => ({ check, claim: byId.get(check.claimId) }));
  const failing = rows.filter((row) => row.check.verdict !== "SUPPORTED");
  const counts = new Map<ClaimBasis["kind"], number>();
  for (const { claim } of rows) {
    if (claim) counts.set(claim.basis.kind, (counts.get(claim.basis.kind) ?? 0) + 1);
  }
  const breakdown = [...counts].map(([kind, count]) => `${count} ${count === 1 ? GROUPS[kind].one : GROUPS[kind].many}`).join(", ");
  const status = failing.length === 0 ? "all supported" : `${failing.length} need attention`;

  return (
    <div className="verification-checks" aria-label="Verification checks">
      <p className="verification-summary"><strong>{rows.length} checked, {status}</strong>{breakdown ? `: ${breakdown}` : ""}.</p>
      {failing.length > 0 ? (
        <ul className="finding-list failures" aria-label="Failing verification checks">
          {failing.map(({ check, claim }) => (
            <li key={check.claimId}>
              <strong>{check.verdict.toLocaleLowerCase("en-US")}</strong>: {claim?.text ?? "Unknown statement"}
              <br /><small>{check.reason}</small>
            </li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary>Show all checks</summary>
        <ul className="reason-list">
          {rows.map(({ check, claim }) => (
            <li key={check.claimId}>
              <strong>{check.verdict.toLocaleLowerCase("en-US")}</strong> · {claim ? GROUPS[claim.basis.kind].one : "statement"}: {claim?.text ?? "Unknown statement"}
              <br /><small>{check.reason}</small>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
