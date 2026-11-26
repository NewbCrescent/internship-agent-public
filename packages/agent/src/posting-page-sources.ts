import { z } from "zod";
import { employerPublication, type PostingPublication } from "@internship-agent/domain";
import { plainText } from "./public-board-source";
import { countryText, greenhouseOfficeLine, joinPlaceParts, withLocation } from "./place-text";

/** The project's existing user agent (packages/github/src/github-rest-client.ts). */
export const POSTING_USER_AGENT = "internship-agent-local";

export type ResolvedPosting = { title: string; url: string; text: string; publication?: PostingPublication | null };

/** A posting that cannot be read deterministically; the reason is shown for manual review. */
export class PostingUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "PostingUnavailable";
  }
}

export type PageSourceTarget =
  | { kind: "dover"; id: string; url: string }
  | { kind: "icims"; host: string; id: string }
  | { kind: "workable"; account: string; shortcode: string }
  | { kind: "rippling"; board: string; id: string }
  | { kind: "greenhouseEmbedded"; id: string; host: string; url: string }
  | { kind: "page"; url: string; key: string };

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const PAGE_SOURCE_KINDS: ReadonlySet<string> = new Set(["dover", "icims", "workable", "rippling", "greenhouseEmbedded", "page"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 5_000_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const MAX_JSON_LD_BLOCKS = 20;
const MAX_JSON_LD_CHARS = 2_000_000;
const JSON_HEADERS = { accept: "application/json", "user-agent": POSTING_USER_AGENT };
const HTML_HEADERS = { accept: "text/html,application/xhtml+xml", "user-agent": POSTING_USER_AGENT };
const RESERVED_SUFFIXES = [".test", ".example", ".invalid", ".localhost", ".local", ".internal", ".lan", ".home.arpa", ".onion", ".corp"];
/** Handshake, aggregators, the lists themselves, and ATS hosts with their own (or no) supported source. */
const EXCLUDED_PAGE_HOSTS = [
  "joinhandshake.com", "handshake.com", "linkedin.com", "indeed.com", "glassdoor.com", "ziprecruiter.com",
  "simplify.jobs", "github.com", "githubusercontent.com", "vansh.nyc", "greenhouse.io", "lever.co", "ashbyhq.com",
  "myworkdayjobs.com", "myworkdaysite.com", "workday.com", "smartrecruiters.com", "oraclecloud.com", "icims.com",
  "dover.io", "dover.com", "workable.com", "rippling.com"
];
const BLOCKED_PATH_SEGMENTS = new Set(["apply", "login", "signin", "sign-in", "signup", "sign-up", "register"]);

export function isPageSourceTarget(target: { kind: string }): target is PageSourceTarget {
  return PAGE_SOURCE_KINDS.has(target.kind);
}

/** Links without a board API of their own; null keeps the row for manual review, never fetched. */
export function identifyPageSource(url: URL): PageSourceTarget | null {
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const host = url.hostname;
  // The request goes to Greenhouse's public board API, never to the employer host.
  const ghJid = url.searchParams.get("gh_jid");
  if (ghJid && /^\d{1,20}$/.test(ghJid)) return { kind: "greenhouseEmbedded", id: ghJid, host, url: cleanUrl(url) };
  if (host === "app.dover.io" && parts.length === 3 && parts[0] === "apply" && UUID.test(parts[2]!)) {
    return { kind: "dover", id: parts[2]!.toLowerCase(), url: "https://app.dover.io/" + parts.join("/") + "/" };
  }
  if (/^[a-z0-9-]+\.icims\.com$/.test(host) && host !== "www.icims.com" && parts[0] === "jobs" &&
    /^\d{1,12}$/.test(parts[1] ?? "") && parts[parts.length - 1] === "job" && (parts.length === 3 || parts.length === 4)) {
    return { kind: "icims", host, id: parts[1]! };
  }
  if (host === "apply.workable.com" && parts[1] === "j" && /^[A-Za-z0-9_-]{1,80}$/.test(parts[0] ?? "") &&
    /^[A-Za-z0-9]{6,16}$/.test(parts[2] ?? "") && (parts.length === 3 || (parts.length === 4 && parts[3] === "apply"))) {
    return { kind: "workable", account: parts[0]!, shortcode: parts[2]!.toUpperCase() };
  }
  if (host === "ats.rippling.com" && parts.length === 3 && parts[1] === "jobs" && /^[A-Za-z0-9_-]{1,80}$/.test(parts[0]!) && UUID.test(parts[2]!)) {
    return { kind: "rippling", board: parts[0]!, id: parts[2]!.toLowerCase() };
  }
  if (isPublicPageHost(host) && !isExcludedPageHost(host) && !parts.some((part) => BLOCKED_PATH_SEGMENTS.has(part.toLowerCase()))) {
    return { kind: "page", url: cleanUrl(url), key: pageKey(url) };
  }
  return null;
}

export function pageSourceKey(target: PageSourceTarget): string {
  switch (target.kind) {
    case "dover": return "dover:" + target.id;
    case "icims": return "icims:" + target.host + ":" + target.id;
    case "workable": return "workable:" + target.account.toLowerCase() + "/" + target.shortcode;
    case "rippling": return "rippling:" + target.id;
    case "greenhouseEmbedded": return "greenhouse:" + target.id;
    case "page": return "page:" + target.key;
  }
}

const doverJobSchema = z.object({
  id: z.string(), title: z.string().min(1), user_provided_description: z.string().nullish(), location: z.string().nullish(),
  locations: z.array(z.object({
    location_option: z.object({
      display_name: z.string().nullish(), city: z.string().nullish(), state: z.string().nullish(), country: z.string().nullish()
    }).nullish()
  })).max(100).nullish(),
  workplace_type: z.string().nullish(), active: z.boolean().nullish(), is_private: z.boolean().nullish()
});
const workablePlace = z.object({
  city: z.string().nullish(), region: z.string().nullish(), country: z.string().nullish(), countryCode: z.string().nullish()
});
const workableJobSchema = z.object({
  shortcode: z.string(), title: z.string().min(1), state: z.string().nullish(), isInternal: z.boolean().nullish(),
  remote: z.boolean().nullish(), description: z.string().nullish(), requirements: z.string().nullish(),
  benefits: z.string().nullish(), published: z.unknown().optional(), location: workablePlace.nullish(),
  locations: z.array(workablePlace.extend({ hidden: z.boolean().nullish() })).max(50).nullish()
});
const ripplingJobSchema = z.object({
  uuid: z.string(), name: z.string().min(1),
  description: z.object({ role: z.string().nullish(), company: z.string().nullish() }),
  workLocations: z.array(z.string()).max(50).nullish(), url: z.string().nullish()
});
const greenhouseEmbeddedJobSchema = z.object({
  id: z.number(), title: z.string(), absolute_url: z.string(), content: z.string().optional(),
  first_published: z.unknown().optional(), location: z.object({ name: z.string() }).optional(),
  offices: z.array(z.object({ name: z.string().nullish(), location: z.string().nullish() })).max(50).nullish()
});

/** Reads one public posting for a page-source target; null means closed, unlisted, or without a description. */
export async function resolvePageSource(
  target: PageSourceTarget,
  fetcher: Fetcher,
  context: { companyName: string }
): Promise<ResolvedPosting | null> {
  if (target.kind === "dover") {
    // The public endpoint behind Dover's own apply page; no sign-in is involved.
    const job = doverJobSchema.parse(await fetchJson("https://app.dover.io/api/v1/inbound/application-portal-job/" + target.id, fetcher));
    const body = plainText(job.user_provided_description ?? "");
    if (job.id.toLowerCase() !== target.id || job.active === false || job.is_private === true || !body) return null;
    // A structured city/state/country names the country in full; display_name is the fallback.
    const names = unique((job.locations ?? []).map((entry) => {
      const option = entry?.location_option;
      if (option?.city?.trim()) return joinPlaceParts([option.city, option.state, countryText(option.country)]);
      return option?.display_name?.trim() ?? "";
    }));
    const location = names.length ? names.join("; ") : job.location?.trim() || (job.workplace_type === "REMOTE" ? "Remote" : null);
    // Dover's `created` is a creation date and never stands in for publication.
    return { title: plainText(job.title).slice(0, 200), url: target.url, text: withLocation(location, body), publication: null };
  }
  if (target.kind === "icims") {
    const html = await fetchHtml("https://" + target.host + "/jobs/" + target.id + "/job?in_iframe=1", fetcher, { followRedirects: false });
    const url = "https://" + target.host + "/jobs/" + target.id + "/job";
    return fromJsonLd(html, url);
  }
  if (target.kind === "workable") {
    const job = workableJobSchema.parse(await fetchJson(
      "https://apply.workable.com/api/v2/accounts/" + encodeURIComponent(target.account) + "/jobs/" + target.shortcode, fetcher
    ));
    if (job.shortcode.toUpperCase() !== target.shortcode || (job.state && job.state !== "published") || job.isInternal === true) return null;
    const body = sections([["", job.description ?? ""], ["Requirements", job.requirements ?? ""], ["Benefits", job.benefits ?? ""]]);
    if (!body) return null;
    const visible = (job.locations ?? []).filter((place) => place.hidden !== true);
    const places = visible.length ? visible : job.location ? [job.location] : [];
    const entries = unique(places.map((place) => joinPlaceParts([place.city, place.region, place.country?.trim() || countryText(place.countryCode)])));
    if (job.remote === true && !entries.includes("Remote")) entries.push("Remote");
    const url = "https://apply.workable.com/" + target.account + "/j/" + target.shortcode + "/";
    return {
      title: plainText(job.title).slice(0, 200), url,
      text: withLocation(entries.length ? entries.join("; ") : null, body),
      publication: employerPublication(job.published, url, "published")
    };
  }
  if (target.kind === "rippling") {
    const job = ripplingJobSchema.parse(await fetchJson(
      "https://api.rippling.com/platform/api/ats/v1/board/" + encodeURIComponent(target.board) + "/jobs/" + target.id, fetcher
    ));
    // Only the role section; the company boilerplate is not part of the posting's requirements.
    const body = plainText(job.description.role ?? "");
    if (job.uuid.toLowerCase() !== target.id || !body) return null;
    const locations = unique(job.workLocations ?? []);
    const canonical = "https://ats.rippling.com/" + target.board + "/jobs/" + target.id;
    const url = job.url && isRipplingPostingUrl(job.url, target.id) ? job.url : canonical;
    // Rippling's createdOn is a creation date and never stands in for publication.
    return { title: plainText(job.name).slice(0, 200), url, text: withLocation(locations.length ? locations.join("; ") : null, body), publication: null };
  }
  if (target.kind === "greenhouseEmbedded") return resolveGreenhouseEmbedded(target, fetcher, context);
  const html = await fetchHtml(target.url, fetcher, { followRedirects: true });
  return fromJsonLd(html, target.url);
}

function fromJsonLd(html: string, url: string): ResolvedPosting {
  const posting = readJobPostingJsonLd(html);
  if (!posting) throw new PostingUnavailable("no schema.org JobPosting data");
  if (posting.expired) throw new PostingUnavailable("the posting's validThrough date has passed");
  return {
    title: posting.title, url,
    text: withLocation(posting.location, posting.body),
    publication: employerPublication(posting.datePosted, url, "datePosted")
  };
}

async function resolveGreenhouseEmbedded(
  target: Extract<PageSourceTarget, { kind: "greenhouseEmbedded" }>,
  fetcher: Fetcher,
  context: { companyName: string }
): Promise<ResolvedPosting | null> {
  const fromName = context.companyName.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const labels = target.host.replace(/^www\./, "").split(".");
  const fromHost = labels.length >= 2 ? labels[labels.length - 2]! : "";
  const slugs = unique([fromName, fromHost]).filter((slug) => /^[a-z0-9]{2,60}$/.test(slug)).slice(0, 2);
  for (const slug of slugs) {
    const response = await fetcher(
      "https://boards-api.greenhouse.io/v1/boards/" + slug + "/jobs/" + target.id + "?content=true",
      { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: JSON_HEADERS }
    );
    if (response.status === 404) { await response.body?.cancel(); continue; }
    if (!response.ok) { await response.body?.cancel(); throw new PostingUnavailable("HTTP " + response.status); }
    const job = greenhouseEmbeddedJobSchema.parse(JSON.parse(await boundedText(response)) as unknown);
    if (String(job.id) !== target.id) continue;
    if (!job.content) return null;
    const url = isGreenhouseUrlFor(job.absolute_url, target.id) ? job.absolute_url : target.url;
    return {
      title: plainText(job.title).slice(0, 200), url,
      text: withLocation(job.location?.name ?? null, plainText(job.content), greenhouseOfficeLine(job)),
      publication: employerPublication(job.first_published, url, "first_published")
    };
  }
  throw new PostingUnavailable("no public Greenhouse board found for the company");
}

function isGreenhouseUrlFor(raw: string, id: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (url.searchParams.get("gh_jid") === id) return true;
  const parts = url.pathname.split("/").filter(Boolean);
  return (url.hostname === "boards.greenhouse.io" || url.hostname === "job-boards.greenhouse.io") &&
    parts.length === 3 && parts[1] === "jobs" && parts[2] === id;
}

function isRipplingPostingUrl(raw: string, id: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname !== "ats.rippling.com") return false;
  // The stored URL must keep the listing's posting identity.
  const target = identifyPageSource(url);
  return target?.kind === "rippling" && target.id === id;
}

export type JsonLdPosting = { title: string; body: string; location: string | null; datePosted: string | null; expired: boolean };

const textish = z.union([z.string(), z.array(z.string()).max(100)]);
const jsonLdPlace = z.object({
  name: z.string().optional(),
  address: z.union([z.string(), z.object({
    addressLocality: z.string().optional(), addressRegion: z.string().optional(),
    addressCountry: z.union([z.string(), z.object({ name: z.string().optional() })]).optional()
  })]).optional()
});
const jsonLdJobPostingSchema = z.object({
  title: z.string().min(1), description: z.string().min(1),
  responsibilities: textish.optional(), qualifications: textish.optional(),
  datePosted: z.string().optional(), validThrough: z.string().optional(),
  jobLocation: z.union([jsonLdPlace, z.array(jsonLdPlace).max(50)]).optional(),
  jobLocationType: z.string().optional()
});

/** The page's single schema.org JobPosting, read without a model; null when absent, ambiguous, or malformed. */
export function readJobPostingJsonLd(html: string, now: number = Date.now()): JsonLdPosting | null {
  const nodes: unknown[] = [];
  let blocks = 0;
  for (const match of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    if (++blocks > MAX_JSON_LD_BLOCKS) break;
    let raw = match[1]!.trim();
    if (raw.startsWith("<!--")) raw = raw.slice(4).trim();
    if (raw.endsWith("-->")) raw = raw.slice(0, -3).trim();
    if (raw.startsWith("//<![CDATA[")) raw = raw.slice(11).trim();
    if (raw.endsWith("//]]>")) raw = raw.slice(0, -5).trim();
    if (raw.length > MAX_JSON_LD_CHARS) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; } catch { continue; }
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      nodes.push(entry);
      const graph = isRecord(entry) ? entry["@graph"] : undefined;
      if (Array.isArray(graph)) nodes.push(...graph);
    }
  }
  const postings = nodes.filter((node): node is Record<string, unknown> => isRecord(node) && isJobPostingType(node["@type"]));
  if (postings.length === 0) return null;
  if (new Set(postings.map((node) => node.title)).size > 1) return null;
  const parsed = jsonLdJobPostingSchema.safeParse(withoutUnavailable(postings[0]));
  if (!parsed.success) return null;
  const job = parsed.data;
  const title = plainText(job.title);
  const description = plainText(job.description);
  if (!title || !description) return null;
  const extra = (value: string | string[] | undefined): string => {
    const html = Array.isArray(value) ? value.join("\n") : value ?? "";
    const text = plainText(html);
    return text && !description.includes(text.slice(0, 80)) ? html : "";
  };
  const body = sections([["", job.description], ["Responsibilities", extra(job.responsibilities)], ["Qualifications", extra(job.qualifications)]]);
  const places = job.jobLocation === undefined ? [] : Array.isArray(job.jobLocation) ? job.jobLocation : [job.jobLocation];
  const locations = unique(places.map((place) => {
    if (typeof place.address === "string" && place.address.trim()) return place.address.trim();
    if (place.address && typeof place.address === "object") {
      const country = countryText(typeof place.address.addressCountry === "string" ? place.address.addressCountry : place.address.addressCountry?.name);
      const joined = joinPlaceParts([place.address.addressLocality, place.address.addressRegion, country]);
      if (joined) return joined;
    }
    return place.name?.trim() ?? "";
  })).slice(0, 10);
  if (job.jobLocationType === "TELECOMMUTE" && !locations.includes("Remote")) locations.push("Remote");
  const datePosted = job.datePosted?.trim() ? job.datePosted.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2") : null;
  const endsAt = job.validThrough ? Date.parse(job.validThrough) : NaN;
  return {
    title, body,
    location: locations.length ? locations.join("; ") : null,
    datePosted,
    expired: Number.isFinite(endsAt) && endsAt < now
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJobPostingType(type: unknown): boolean {
  return type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
}

/** iCIMS and Jibe pages fill unknown fields with "UNAVAILABLE"; it counts as empty. */
function withoutUnavailable(value: unknown): unknown {
  if (typeof value === "string") return value.trim().toUpperCase() === "UNAVAILABLE" ? "" : value;
  if (Array.isArray(value)) return value.map(withoutUnavailable);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withoutUnavailable(entry)]));
  return value;
}

function cleanUrl(url: URL): string {
  const query = withoutTracking(url).toString();
  return "https://" + url.hostname + url.pathname + (query ? "?" + query : "");
}

function pageKey(url: URL): string {
  const params = withoutTracking(url);
  params.sort();
  const query = params.toString();
  return url.hostname + url.pathname.replace(/\/+$/, "") + (query ? "?" + query : "");
}

function withoutTracking(url: URL): URLSearchParams {
  return new URLSearchParams([...url.searchParams].filter(([name]) => !name.startsWith("utm_") && name !== "ref"));
}

function isPublicPageHost(host: string): boolean {
  if (!host.includes(".") || host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === "localhost" || !/^[a-z0-9.-]+$/.test(host)) return false;
  return !RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function isExcludedPageHost(host: string): boolean {
  return EXCLUDED_PAGE_HOSTS.some((excluded) => host === excluded || host.endsWith("." + excluded));
}

async function fetchJson(url: string, fetcher: Fetcher): Promise<unknown> {
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: JSON_HEADERS });
  if (!response.ok) { await response.body?.cancel(); throw new PostingUnavailable("HTTP " + response.status); }
  return JSON.parse(await boundedText(response)) as unknown;
}

/** Same-host redirects, plus one move to another public host on the same path; at most three; HTML only. */
async function fetchHtml(url: string, fetcher: Fetcher, options: { followRedirects: boolean }): Promise<string> {
  let current = url;
  let movedHost = false;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetcher(current, {
      redirect: options.followRedirects ? "manual" : "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: HTML_HEADERS
    });
    if (options.followRedirects && [301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      let next: URL;
      try { next = new URL(location ?? "", current); } catch { throw new PostingUnavailable("redirected away from the posting's site"); }
      const from = new URL(current);
      const sameHost = next.hostname === from.hostname;
      // An Avature site (tql.avature.net) answers with a 301 to the employer's own career domain on the same path.
      const samePathMove = !sameHost && !movedHost && next.pathname === from.pathname &&
        isPublicPageHost(next.hostname) && !isExcludedPageHost(next.hostname);
      if (!location || next.protocol !== "https:" || next.username || next.password || next.port || !(sameHost || samePathMove)) {
        throw new PostingUnavailable("redirected away from the posting's site");
      }
      if (samePathMove) movedHost = true;
      current = next.toString();
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new PostingUnavailable("HTTP " + response.status); }
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("html")) {
      await response.body?.cancel();
      throw new PostingUnavailable("not an HTML page");
    }
    return boundedText(response);
  }
  throw new PostingUnavailable("too many redirects");
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new PostingUnavailable("empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new PostingUnavailable("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/** Joins titled HTML sections, keeping each heading so the extractor sees it. */
function sections(parts: ReadonlyArray<readonly [string, string]>): string {
  return parts.map(([title, html]) => [title, plainText(html)] as const)
    .filter(([, text]) => text.length > 0)
    .map(([title, text]) => (title ? title + ":\n" : "") + text)
    .join("\n\n");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
