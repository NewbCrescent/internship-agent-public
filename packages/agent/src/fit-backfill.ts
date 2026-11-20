/**
 * Orders AI-backfill work so the freshest employer publications score first.
 * Pure ordering over posting summaries; the script resolves the summaries and
 * runs the analysis. Unknown, malformed, or future publication dates keep
 * their incoming (import) order after the priority window.
 */
export function isPriorityPublication(
  publication: { postedAt: string } | null | undefined,
  priorityDays: number,
  nowMs: number = Date.now()
): boolean {
  if (priorityDays <= 0 || !publication) return false;
  const at = Date.parse(publication.postedAt);
  return Number.isFinite(at) && at >= nowMs - priorityDays * 86_400_000 && at <= nowMs;
}

export function prioritizeByPublication<T extends { publication?: { postedAt: string } | null }>(
  postings: readonly T[],
  priorityDays: number,
  nowMs: number = Date.now()
): T[] {
  if (priorityDays <= 0) return [...postings];
  const postedAtOf = (posting: T) => {
    const at = posting.publication ? Date.parse(posting.publication.postedAt) : Number.NaN;
    return Number.isFinite(at) ? at : 0;
  };
  const isPriority = (posting: T) => isPriorityPublication(posting.publication, priorityDays, nowMs);
  return [
    ...postings.filter(isPriority).sort((a, b) => postedAtOf(b) - postedAtOf(a)),
    ...postings.filter((posting) => !isPriority(posting))
  ];
}
