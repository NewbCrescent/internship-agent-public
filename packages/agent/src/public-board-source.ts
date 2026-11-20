import { z } from "zod";
import { discoveredItemSchema, employerPublication, type PostingPublication, type DiscoveredItem } from "@internship-agent/domain";

type Board = { kind: "greenhouse" | "lever" | "ashby"; slug: string };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const MAX_RESPONSE_BYTES = 5_000_000;

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
  fetcher: Fetcher = fetch
): Promise<DiscoveredItem[]> {
  const board = parsePublicBoardUrl(source.url);
  const endpoint = board.kind === "greenhouse"
    ? `https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs?content=true`
    : board.kind === "lever"
      ? `https://api.lever.co/v0/postings/${board.slug}?mode=json`
      : `https://api.ashbyhq.com/posting-api/job-board/${board.slug}`;
  const response = await fetcher(endpoint, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`The public board answered ${response.status}.`);
  const payload = await boundedJson(response);
  const jobs: Array<{ title: string; url: string; text: string; publication?: PostingPublication | null }> = board.kind === "greenhouse"
    ? z.object({ jobs: z.array(greenhouseJob).max(2_000) }).parse(payload).jobs.map((job) => ({ title: job.title, url: job.absolute_url, text: job.content ?? "", publication: employerPublication(job.first_published, job.absolute_url, "first_published") }))
    : board.kind === "lever"
      ? z.array(leverJob).max(2_000).parse(payload).map((job) => ({ title: job.text, url: job.hostedUrl, text: job.descriptionPlain ?? job.description ?? "" }))
      : z.object({ jobs: z.array(ashbyJob).max(2_000) }).parse(payload).jobs.filter((job) => job.isListed !== false).map((job) => ({ title: job.title, url: job.jobUrl, text: job.descriptionPlain ?? job.descriptionHtml ?? "", publication: employerPublication(job.publishedAt, job.jobUrl, "publishedAt") }));
  return jobs
    .filter((job) => /\b(intern|internship|co-op)\b/i.test(job.title) && validPostingUrl(job.url))
    .map((job) => ({ title: job.title, companyName: source.label, text: plainText(job.text), sourceUrl: job.url, publication: job.publication ?? null }))
    .filter((job) => job.text.length >= 80)
    .slice(0, 100)
    .map((job) => discoveredItemSchema.parse(job));
}
