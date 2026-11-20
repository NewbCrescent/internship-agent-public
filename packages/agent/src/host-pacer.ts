export type PacedFetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const waitFor: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts requests to the same host at least intervalMs apart (start to start).
 * The slot is reserved before waiting, so concurrent callers queue in order.
 */
export function pacePerHost(
  fetcher: PacedFetcher,
  intervalMs: number,
  options: { sleep?: Sleep; now?: () => number } = {}
): PacedFetcher {
  const nextStart = new Map<string, number>();
  const sleep = options.sleep ?? waitFor;
  const now = options.now ?? Date.now;
  return async (url, init) => {
    let host: string;
    try { host = new URL(url).hostname; } catch { return fetcher(url, init); }
    const slot = Math.max(now(), nextStart.get(host) ?? 0);
    nextStart.set(host, slot + intervalMs);
    const wait = slot - now();
    if (wait > 0) await sleep(wait);
    return fetcher(url, init);
  };
}
