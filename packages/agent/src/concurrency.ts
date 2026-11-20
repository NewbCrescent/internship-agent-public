/**
 * Postings ingested at once. Each may issue a few model calls; the shared
 * rate limiter, not this number, keeps calls inside the provider's limits.
 * At about 21 s per call, 32 postings keep roughly 90 requests a minute
 * flowing.
 */
export function modelConcurrency(env: Record<string, string | undefined> = process.env): number {
  const raw = env.INTERNSHIP_AGENT_MODEL_CONCURRENCY?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 32;
  return Math.min(64, Math.max(1, parsed));
}

/** Runs `task` over `items` with at most `limit` in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
