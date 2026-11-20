import type { JobConstraints } from "@internship-agent/domain";

type ConstraintRow = { kind: string; label: string; detail: string; raw: string };

/**
 * Silence is shown as silence. A posting that says nothing about sponsorship
 * reads "Not stated", never "no sponsorship", because Milestone 4 must not
 * disqualify a candidate on a constraint the employer never wrote down.
 */
export function ConstraintSummary({ constraints }: { constraints: JobConstraints }) {
  const rows: ConstraintRow[] = [];

  if (constraints.graduation) {
    rows.push({
      kind: "graduation",
      label: "Graduation",
      detail: dateWindow(constraints.graduation.earliest, constraints.graduation.latest),
      raw: constraints.graduation.raw
    });
  }
  if (constraints.authorization) {
    rows.push({
      kind: "authorization",
      label: "Work authorization",
      detail: constraints.authorization.requiresExistingAuthorization
        ? `Existing authorization required${country(constraints.authorization.countryCode)}`
        : `Authorization not required${country(constraints.authorization.countryCode)}`,
      raw: constraints.authorization.raw
    });
  }
  if (constraints.sponsorship) {
    rows.push({
      kind: "sponsorship",
      label: "Sponsorship",
      detail: constraints.sponsorship.sponsorshipAvailable
        ? `Sponsorship available${country(constraints.sponsorship.countryCode)}`
        : `Sponsorship not available${country(constraints.sponsorship.countryCode)}`,
      raw: constraints.sponsorship.raw
    });
  }
  if (constraints.availability) {
    rows.push({
      kind: "availability",
      label: "Availability",
      detail: dateWindow(constraints.availability.earliestStart, constraints.availability.latestStart),
      raw: constraints.availability.raw
    });
  }

  const unstated = (["graduation", "authorization", "sponsorship", "availability"] as const)
    .filter((kind) => constraints[kind] === null);

  return (
    <div className="constraint-summary">
      <h3>Eligibility constraints</h3>
      {rows.length === 0 ? (
        <p className="stale-note">None stated.</p>
      ) : (
        <ul className="constraint-list">
          {rows.map((row) => (
            <li key={row.kind}>
              <div><strong>{row.label}</strong><span>{row.detail}</span></div>
              <blockquote><p>{row.raw}</p></blockquote>
            </li>
          ))}
        </ul>
      )}
      {unstated.length > 0 ? (
        <p className="constraint-unstated">
          Not stated: {unstated.join(", ")}. Treated as unknown, never as a no.
        </p>
      ) : null}
    </div>
  );
}

function dateWindow(earliest: string | null, latest: string | null): string {
  if (!earliest && !latest) return "Stated without a specific date";
  if (earliest && latest) return earliest === latest ? earliest : `${earliest} to ${latest}`;
  return earliest ?? latest ?? "Stated without a specific date";
}

function country(code: string | null): string {
  return code ? ` (${code})` : "";
}
