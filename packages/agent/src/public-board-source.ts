import { z } from "zod";
import { discoveredItemSchema, employerPublication, type PostingPublication, type DiscoveredItem } from "@internship-agent/domain";

import type { DiscoveryFetchEvent, DiscoveryRowEvent } from "./discovery-trace";

export type PublicBoard = { kind: "greenhouse" | "lever" | "ashby"; slug: string };
type Board = PublicBoard;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_BOARD_POSTINGS = 100;
const INTERN_TITLE = /\b(intern|internship|co-op)\b/i;

/** A board request that failed; `status` is the HTTP status when the board answered. */
export class PublicBoardError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "PublicBoardError";
  }
}

const greenhouseJob = z.object({ title: z.string(), absolute_url: z.url(), content: z.string().optional(), first_published: z.unknown().optional() });
const leverJob = z.object({ text: z.string(), hostedUrl: z.url(), descriptionPlain: z.string().optional(), description: z.string().optional() });
const ashbyJob = z.object({ publishedAt: z.unknown().optional(), title: z.string(), jobUrl: z.url(), isListed: z.boolean().optional(), descriptionPlain: z.string().optional(), descriptionHtml: z.string().optional() });

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

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("The public board returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("The public board response is too large to process safely.");
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
  let jobs: Array<{ title: string; url: string; text: string; publication?: PostingPublication | null }>;
  try {
    const response = await fetcher(endpoint, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    status = response.status;
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* the status is the answer */ }
      throw new PublicBoardError(`The public board answered ${response.status}.`, response.status);
    }
    const payload = await boundedJson(response);
    jobs = board.kind === "greenhouse"
      ? z.object({ jobs: z.array(greenhouseJob).max(2_000) }).parse(payload).jobs.map((job) => ({ title: job.title, url: job.absolute_url, text: job.content ?? "", publication: employerPublication(job.first_published, job.absolute_url, "first_published") }))
      : board.kind === "lever"
        ? z.array(leverJob).max(2_000).parse(payload).map((job) => ({ title: job.text, url: job.hostedUrl, text: job.descriptionPlain ?? job.description ?? "" }))
        : z.object({ jobs: z.array(ashbyJob).max(2_000) }).parse(payload).jobs.filter((job) => job.isListed !== false).map((job) => ({ title: job.title, url: job.jobUrl, text: job.descriptionPlain ?? job.descriptionHtml ?? "", publication: employerPublication(job.publishedAt, job.jobUrl, "publishedAt") }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    observe.onFetch?.({
      url: endpoint, decision: "board-fetch-failed",
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
    const text = plainText(job.text);
    if (text.length < 80) {
      rows.push({ ...base, decision: "unavailable", reason: "the board gives fewer than 80 characters of description" });
      return;
    }
    if (kept.length >= MAX_BOARD_POSTINGS) {
      rows.push({ ...base, decision: "not-reached", reason: `past this board's limit of ${MAX_BOARD_POSTINGS} internship postings` });
      return;
    }
    kept.push(discoveredItemSchema.parse({ title: job.title, companyName: source.label, text, sourceUrl: job.url, publication: job.publication ?? null }));
    rows.push({ ...base, decision: "resolved", reason: "read from the public board", postingUrl: job.url });
  });
  observe.onFetch?.({
    url: endpoint, decision: "board-fetched", status,
    reason: `${jobs.length} jobs, ${internships} internship titles, ${kept.length} kept`,
    jobs: jobs.length, internships, kept: kept.length
  });
  for (const row of rows) observe.onRow?.(row);
  return kept;
}

function hostOf(raw: string): string {
  try { return new URL(raw).hostname; } catch { return ""; }
}
