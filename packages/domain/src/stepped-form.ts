/** Track 74: a several-page form walked on a site without its own adapter keeps each step's field ids as `step-<n>::<id>`, n the site's own step number. */
const STEPPED_ID = /^step-(\d{1,2})::([\s\S]+)$/;

export function steppedFieldId(step: number, id: string): string {
  return `step-${step}::${id}`;
}

/** The step and the page's own field id of a stepped field id, or null for any other id. Pure. */
export function parseSteppedFieldId(id: string): { step: number; id: string } | null {
  const match = STEPPED_ID.exec(id);
  if (!match) return null;
  const step = Number.parseInt(match[1]!, 10);
  if (step < 1) return null;
  return { step, id: match[2]! };
}

/** Whether a run's decisions or pauses were made by the stepped walk. Pure. */
export function isSteppedRun(run: { decisions: ReadonlyArray<{ fieldId?: string }>; pauses?: ReadonlyArray<{ fieldId: string }> }): boolean {
  return run.decisions.some((decision) => decision.fieldId !== undefined && parseSteppedFieldId(decision.fieldId) !== null)
    || (run.pauses ?? []).some((pause) => parseSteppedFieldId(pause.fieldId) !== null);
}

export const STEPPED_FORM_BLOCKER = "This application continues over several pages on a site the agent has no adapter for, so you approve each one.";
