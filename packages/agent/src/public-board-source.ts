import { z } from "zod";
import { discoveredItemSchema, employerPublication, type PostingPublication, type DiscoveredItem } from "@internship-agent/domain";

import type { DiscoveryFetchEvent, DiscoveryRowEvent } from "./discovery-trace";
import { ashbyLocation, greenhouseOfficeLine, leverLocation, withLocation } from "./place-text";

export type PublicBoard = { kind: "greenhouse" | "lever" | "ashby"; slug: string };
type Board = PublicBoard;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const MAX_RESPONSE_BYTES = 5_000_000;
/** Ashby's posting API has no paging and no content-free list, so an Ashby board's answer may be this large (Shield AI's was 9.9 MB on 2026-11-26). */
const MAX_ASHBY_RESPONSE_BYTES = 16_000_000;
/** An oversized Lever board is read again in pages of this many jobs, at most MAX_LEVER_PAGES pages (2,000 jobs). */
const LEVER_PAGE_SIZE = 100;
const MAX_LEVER_PAGES = 20;
/** An oversized Greenhouse board's internship postings are read one request at a time, within these limits per board. */
const MAX_POSTING_REQUESTS = 120;
const POSTING_REQUESTS_TIME_MS = 120_000;
const MAX_BOARD_POSTINGS = 100;
const INTERN_TITLE = /\b(intern|internship|co-op)\b/i;

/** A board request that failed; `status` is the HTTP status when the board answered. */
export class PublicBoardError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "PublicBoardError";
  }
}

/** A board answer past its byte limit; an oversized Greenhouse or Lever board is read again in smaller requests. */
class BoardResponseTooLarge extends Error {
  constructor() {
    super("The public board response is too large to process safely.");
    this.name = "BoardResponseTooLarge";
  }
}

/** A board's job as read; `unread` marks an internship title whose posting could not be read this check. */
type BoardJob = {
  title: string;
  url: string;
  text: string;
  publication?: PostingPublication | null;
  /** The board's stated place, written as the posting's `Location:` and `Office:` lines. */
  location?: string;
  office?: string | null;
  unread?: { decision: "unavailable" | "not-reached"; reason: string };
};
type BoardRead = { jobs: BoardJob[]; status: number; endpoint: string; note: string };

// Location fields fall back to null on an unexpected shape, so one job's location never fails the whole board.
const greenhouseJob = z.object({
  title: z.string(), absolute_url: z.url(), content: z.string().optional(), first_published: z.unknown().optional(),
  location: z.object({ name: z.string() }).nullish().catch(null),
  offices: z.array(z.object({ name: z.string().nullish(), location: z.string().nullish() })).nullish().catch(null)
});
const leverJob = z.object({
  text: z.string(), hostedUrl: z.url(), descriptionPlain: z.string().optional(), description: z.string().optional(),
  country: z.string().nullish().catch(null),
  categories: z.object({ location: z.string().nullish(), allLocations: z.array(z.string()).nullish() }).nullish().catch(null)
});
const ashbyAddress = z.object({
  postalAddress: z.object({ addressLocality: z.string().nullish(), addressRegion: z.string().nullish(), addressCountry: z.string().nullish() }).nullish()
}).nullish();
const ashbyJob = z.object({
  publishedAt: z.unknown().optional(), title: z.string(), jobUrl: z.url(), isListed: z.boolean().optional(), descriptionPlain: z.string().optional(), descriptionHtml: z.string().optional(),
  location: z.string().nullish().catch(null),
  address: ashbyAddress.catch(null),
  secondaryLocations: z.array(z.object({ location: z.string().nullish(), address: ashbyAddress })).nullish().catch(null)
});

/** The board's stated place for each board kind, as the posting's Location and Office lines (the GitHub list's resolvers write the same lines). */
function greenhousePlaces(job: z.infer<typeof greenhouseJob>): Pick<BoardJob, "location" | "office"> {
  return { location: job.location?.name?.trim() || undefined, office: greenhouseOfficeLine({ location: job.location ?? null, offices: job.offices?.slice(0, 50) ?? null }) };
}
function leverPlaces(job: z.infer<typeof leverJob>): Pick<BoardJob, "location" | "office"> {
  return { location: leverLocation({ country: job.country, categories: job.categories ? { location: job.categories.location, allLocations: job.categories.allLocations?.slice(0, 50) ?? null } : null }), office: null };
}
function ashbyPlaces(job: z.infer<typeof ashbyJob>): Pick<BoardJob, "location" | "office"> {
  return { location: ashbyLocation({ location: job.location, address: job.address, secondaryLocations: job.secondaryLocations?.slice(0, 50) ?? null }), office: null };
}

/** Only explicit public board URLs can enter automated discovery. */
export function parsePublicBoardUrl(raw: string): Board {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Enter a public job-board URL."); }
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || parts.length !== 1 || !/^[a-zA-Z0-9_-]+$/.test(parts[0])) {
    throw new Error("Enter a public board URL with only its company slug.");
  }
  if (url.hostname === "boards.greenhouse.io" || url.hostname === "job-boards.greenhouse.io") return { kind: "greenhouse", slug: parts[0] };
  if (url.hostname === "jobs.lever.co") return { kind: "lever", slug: parts[0] };
  if (url.hostname === "jobs.ashbyhq.com") return { kind: "ashby", slug: parts[0] };
  throw new Error("This source is unsupported. Paste its listings manually instead.");
}

export function plainText(markup: string): string {
  // Greenhouse encodes the post's HTML as entities, sometimes twice.
  const decode = (value: string) => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name: string) => {
    if (name.startsWith("#")) {
      const point = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[name.toLowerCase()] ?? entity;
  });
  const decoded = decode(decode(markup));
  return decoded.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    // Keep HTML list semantics: the requirement extractor recognizes bullets,
    // while a plain newline would silently discard every list item.
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<\/?(?:p|div|ul|ol|br|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n- \n\s*/g, "\n- ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function validPostingUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

async function boundedJson(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  if (!response.body) throw new Error("The public board returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new BoardResponseTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export async function fetchPublicBoard(
  source: { label: string; url: string },
  fetcher: Fetcher = fetch,
  observe: { onRow?: (event: DiscoveryRowEvent) => void; onFetch?: (event: DiscoveryFetchEvent) => void } = {}
): Promise<DiscoveredItem[]> {
  const board = parsePublicBoardUrl(source.url);
  const endpoint = board.kind === "greenhouse"
    ? `https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs?content=true`
    : board.kind === "lever"
      ? `https://api.lever.co/v0/postings/${board.slug}?mode=json`
      : `https://api.ashbyhq.com/posting-api/job-board/${board.slug}`;
  let status: number;
  let jobs: BoardJob[];
  let traced = endpoint;
  let note = "";
  try {
    const response = await fetcher(endpoint, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    status = response.status;
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* the status is the answer */ }
      throw new PublicBoardError(`The public board answered ${response.status}.`, response.status);
    }
    let payload: unknown;
    let oversized = false;
    try {
      payload = await boundedJson(response, board.kind === "ashby" ? MAX_ASHBY_RESPONSE_BYTES : MAX_RESPONSE_BYTES);
    } catch (error) {
      if (!(error instanceof BoardResponseTooLarge) || board.kind === "ashby") throw error;
      oversized = true;
    }
    if (oversized) {
      // Too large in one answer: Greenhouse's content-free list plus each internship posting, or Lever's pages.
      const reread = board.kind === "greenhouse" ? await readGreenhouseByPosting(board.slug, fetcher) : await readLeverPages(board.slug, fetcher);
      jobs = reread.jobs;
      status = reread.status;
      traced = reread.endpoint;
      note = reread.note;
    } else jobs = board.kind === "greenhouse"
      ? z.object({ jobs: z.array(greenhouseJob).max(2_000) }).parse(payload).jobs.map((job) => ({ title: job.title, url: job.absolute_url, text: job.content ?? "", publication: employerPublication(job.first_published, job.absolute_url, "first_published"), ...greenhousePlaces(job) }))
      : board.kind === "lever"
        ? z.array(leverJob).max(2_000).parse(payload).map((job) => ({ title: job.text, url: job.hostedUrl, text: job.descriptionPlain ?? job.description ?? "", ...leverPlaces(job) }))
        : z.object({ jobs: z.array(ashbyJob).max(2_000) }).parse(payload).jobs.filter((job) => job.isListed !== false).map((job) => ({ title: job.title, url: job.jobUrl, text: job.descriptionPlain ?? job.descriptionHtml ?? "", publication: employerPublication(job.publishedAt, job.jobUrl, "publishedAt"), ...ashbyPlaces(job) }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    observe.onFetch?.({
      url: traced, decision: "board-fetch-failed",
      status: error instanceof PublicBoardError ? error.status : null, reason: message.slice(0, 300)
    });
    throw error;
  }

  // Internship titles are traced row by row; other titles are only counted on the fetch line.
  const rows: DiscoveryRowEvent[] = [];
  const kept: DiscoveredItem[] = [];
  let internships = 0;
  jobs.forEach((job, index) => {
    if (!INTERN_TITLE.test(job.title)) return;
    internships += 1;
    const base = { row: index + 1, company: source.label, title: job.title, url: job.url, host: hostOf(job.url) };
    if (!validPostingUrl(job.url)) {
      rows.push({ ...base, decision: "invalid-link", reason: "the board's posting link is not a public https link" });
      return;
    }
    if (job.unread) {
      rows.push({ ...base, decision: job.unread.decision, reason: job.unread.reason });
      return;
    }
    const description = plainText(job.text);
    if (description.length < 80) {
      rows.push({ ...base, decision: "unavailable", reason: "the board gives fewer than 80 characters of description" });
      return;
    }
    if (kept.length >= MAX_BOARD_POSTINGS) {
      rows.push({ ...base, decision: "not-reached", reason: `past this board's limit of ${MAX_BOARD_POSTINGS} internship postings` });
      return;
    }
    const text = withLocation(job.location, description, job.office ?? null).slice(0, 60_000);
    kept.push(discoveredItemSchema.parse({ title: job.title, companyName: source.label, text, sourceUrl: job.url, publication: job.publication ?? null }));
    rows.push({ ...base, decision: "resolved", reason: "read from the public board", postingUrl: job.url });
  });
  observe.onFetch?.({
    url: traced, decision: "board-fetched", status,
    reason: `${jobs.length} jobs, ${internships} internship titles, ${kept.length} kept` + (note ? `; ${note}` : ""),
    jobs: jobs.length, internships, kept: kept.length
  });
  for (const row of rows) observe.onRow?.(row);
  return kept;
}

/** The same request options as a board's first request: no redirects, a 15-second timeout. */
const boardRequest = (): RequestInit => ({ redirect: "error", signal: AbortSignal.timeout(15_000) });

async function answerOk(response: Response): Promise<void> {
  if (response.ok) return;
  try { await response.body?.cancel(); } catch { /* the status is the answer */ }
  throw new PublicBoardError(`The public board answered ${response.status}.`, response.status);
}

/**
 * An oversized Greenhouse board: its content-free job list, then each
 * internship posting's own request, one at a time, within the per-board
 * limits. Other titles are listed without a request.
 */
async function readGreenhouseByPosting(slug: string, fetcher: Fetcher): Promise<BoardRead> {
  const endpoint = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  const response = await fetcher(endpoint, boardRequest());
  await answerOk(response);
  const listed = z.object({
    jobs: z.array(z.object({ id: z.number().int().positive(), title: z.string(), absolute_url: z.url(), first_published: z.unknown().optional() })).max(10_000)
  }).parse(await boundedJson(response)).jobs;
  const started = Date.now();
  let requests = 0;
  let withText = 0;
  const jobs: BoardJob[] = [];
  for (const job of listed) {
    const entry: BoardJob = { title: job.title, url: job.absolute_url, text: "" };
    jobs.push(entry);
    if (!INTERN_TITLE.test(job.title) || !validPostingUrl(job.absolute_url)) continue;
    if (withText >= MAX_BOARD_POSTINGS) {
      entry.unread = { decision: "not-reached", reason: `past this board's limit of ${MAX_BOARD_POSTINGS} internship postings` };
      continue;
    }
    if (requests >= MAX_POSTING_REQUESTS) {
      entry.unread = { decision: "not-reached", reason: `past this board's limit of ${MAX_POSTING_REQUESTS} posting requests` };
      continue;
    }
    if (Date.now() - started >= POSTING_REQUESTS_TIME_MS) {
      entry.unread = { decision: "not-reached", reason: `past this board's ${POSTING_REQUESTS_TIME_MS / 1000}-second limit for posting requests` };
      continue;
    }
    requests += 1;
    try {
      const answer = await fetcher(`${endpoint}/${job.id}`, boardRequest());
      if (!answer.ok) {
        try { await answer.body?.cancel(); } catch { /* the status is the answer */ }
        entry.unread = { decision: "unavailable", reason: `the board's posting request answered ${answer.status}` };
        continue;
      }
      const detail = greenhouseJob.parse(await boundedJson(answer));
      Object.assign(entry, greenhousePlaces(detail));
      entry.text = detail.content ?? "";
      entry.publication = employerPublication(detail.first_published ?? job.first_published, job.absolute_url, "first_published");
      if (plainText(entry.text).length >= 80) withText += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.unread = { decision: "unavailable", reason: `the board's posting request failed: ${message.slice(0, 200)}` };
    }
  }
  return {
    jobs, status: response.status, endpoint,
    note: `the full board was over 5 MB, so its job list and ${requests} postings were read one by one`
  };
}

/**
 * An oversized Lever board read again in pages; only internship titles keep
 * their text between pages, so memory stays bounded.
 */
async function readLeverPages(slug: string, fetcher: Fetcher): Promise<BoardRead> {
  const pageUrl = (page: number) => `https://api.lever.co/v0/postings/${slug}?mode=json&skip=${page * LEVER_PAGE_SIZE}&limit=${LEVER_PAGE_SIZE}`;
  const seen = new Set<string>();
  const jobs: BoardJob[] = [];
  let status = 0;
  let pages = 0;
  let lastFull = false;
  for (let page = 0; page < MAX_LEVER_PAGES; page += 1) {
    const response = await fetcher(pageUrl(page), boardRequest());
    await answerOk(response);
    if (page === 0) status = response.status;
    const entries = z.array(leverJob).max(LEVER_PAGE_SIZE).parse(await boundedJson(response));
    pages += 1;
    for (const job of entries) {
      if (seen.has(job.hostedUrl)) continue;
      seen.add(job.hostedUrl);
      jobs.push(INTERN_TITLE.test(job.text)
        ? { title: job.text, url: job.hostedUrl, text: job.descriptionPlain ?? job.description ?? "", ...leverPlaces(job) }
        : { title: job.text, url: job.hostedUrl, text: "" });
    }
    lastFull = entries.length >= LEVER_PAGE_SIZE;
    if (!lastFull) break;
  }
  return {
    jobs, status, endpoint: pageUrl(0),
    note: `the full board was over 5 MB, so it was read in ${pages} pages of ${LEVER_PAGE_SIZE}` +
      (lastFull && pages >= MAX_LEVER_PAGES ? `; stopped at ${MAX_LEVER_PAGES} pages` : "")
  };
}

function hostOf(raw: string): string {
  try { return new URL(raw).hostname; } catch { return ""; }
}
