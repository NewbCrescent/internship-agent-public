import { z } from "zod";
import { greenhouseBoardSlugs, POSTING_USER_AGENT } from "./posting-page-sources";

/**
 * Greenhouse's public board API, asked whether an employer careers page carrying `gh_jid` is a Greenhouse job whose
 * embed serves its application (Track 77). Amperity draws Greenhouse's embed only after its cookies are accepted, and
 * newsletter boxes hid the embed on others, so the run opens the application Greenhouse itself names. The board is
 * confirmed, never guessed: Greenhouse must list the same job id with this page as its public address (`absolute_url`
 * on the same host carrying the same `gh_jid`), and the embed address must answer 200 without a redirect (a wrong
 * board answers 302 to an error page). Only the board slug and the job id are sent; no candidate data.
 */

export type GreenhouseEmbedMatch = { board: string; jobId: string; embedUrl: string };

export type GreenhouseEmbedLookup = (input: { applicationUrl: string; companyName: string }) => Promise<GreenhouseEmbedMatch | null>;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;
const MAX_BODY_LENGTH = 5_000_000;
const boardJobSchema = z.object({ id: z.number(), absolute_url: z.string() });

/** An https employer page (not on greenhouse.io) whose `gh_jid` names a Greenhouse job id. */
export function employerGreenhouseJobId(url: string): { host: string; id: string } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
  const host = parsed.hostname.toLowerCase();
  if (host === "greenhouse.io" || host.endsWith(".greenhouse.io")) return null;
  const id = parsed.searchParams.get("gh_jid") ?? "";
  if (!/^\d{1,20}$/.test(id)) return null;
  return { host, id };
}

/** Greenhouse's embed address for a board's job application. */
export function greenhouseEmbedAddress(board: string, id: string): string {
  return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${id}`;
}

const withoutWww = (host: string): string => host.toLowerCase().replace(/^www\./, "");

/** Whether Greenhouse's `absolute_url` names this employer page's host and job id. */
function namesThisPage(raw: string, host: string, id: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:") return false;
  return withoutWww(url.hostname) === withoutWww(host) && url.searchParams.get("gh_jid") === id;
}

/**
 * The Greenhouse embed serving an employer page's gh_jid job, or null when the page carries no gh_jid, no board
 * Greenhouse confirms lists it with this page, the embed does not answer 200, or any request fails (the run then
 * proceeds as before).
 */
export async function findGreenhouseEmbed(
  input: { applicationUrl: string; companyName: string },
  fetcher: Fetcher = fetch
): Promise<GreenhouseEmbedMatch | null> {
  const page = employerGreenhouseJobId(input.applicationUrl);
  if (!page) return null;
  try {
    for (const board of greenhouseBoardSlugs(input.companyName, page.host)) {
      const response = await fetcher(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${page.id}`, {
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json", "user-agent": POSTING_USER_AGENT }
      });
      if (response.status === 404) { await response.body?.cancel(); continue; }
      if (!response.ok) { await response.body?.cancel(); return null; }
      const text = await response.text();
      if (text.length > MAX_BODY_LENGTH) return null;
      const job = boardJobSchema.safeParse(JSON.parse(text) as unknown);
      if (!job.success) return null;
      if (String(job.data.id) !== page.id || !namesThisPage(job.data.absolute_url, page.host, page.id)) return null;
      const embedUrl = greenhouseEmbedAddress(board, page.id);
      const embed = await fetcher(embedUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": POSTING_USER_AGENT }
      });
      await embed.body?.cancel();
      return embed.status === 200 ? { board, jobId: page.id, embedUrl } : null;
    }
    return null;
  } catch {
    return null;
  }
}
