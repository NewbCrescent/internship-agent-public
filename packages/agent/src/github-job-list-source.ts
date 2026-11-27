import { z } from "zod";
import { discoveredItemSchema, employerPublication, type PostingPublication, type DiscoveredItem } from "@internship-agent/domain";
import { locationCountryCodes } from "@internship-agent/jobs";
import { plainText } from "./public-board-source";
import {
  identifyPageSource, isPageSourceTarget, pageSourceKey, resolvePageSource, PostingUnavailable, POSTING_USER_AGENT,
  type PageSourceTarget, type ResolvedPosting
} from "./posting-page-sources";
import { pacePerHost, waitFor, type Sleep } from "./host-pacer";
import { ashbyLocation, greenhouseOfficeLine, leverLocation, withLocation } from "./place-text";
import type { DiscoveryListDecision, DiscoveryRowEvent } from "./discovery-trace";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
/**
 * A list row. `ageDays` is how long the row has been listed (the list's Age
 * column, or Vansh's date_posted), null when the list states none; `location`
 * is the list's location column; `season` is Vansh's stated season. `row` is
 * the 1-based position in the parse output (file order for Simplify and
 * Speedy; for Vansh the valid rows newest first, then the malformed ones).
 * `rejected` marks a row the parser already rules out, with its reason.
 */
type Listing = {
  companyName: string; title: string; url: string; ageDays: number | null; location: string | null; season: string | null;
  row: number; rejected?: { decision: "closed" | "not-internship" | "failed-to-parse"; reason: string };
};
type ParsedListing = Omit<Listing, "row">;
type BoardTarget =
  | { kind: "greenhouse"; slug: string; id: string }
  | { kind: "lever"; slug: string; id: string; eu: boolean }
  | { kind: "ashby"; slug: string; id: string }
  | { kind: "workday"; host: string; tenant: string; site: string; path: string }
  | { kind: "smartrecruiters"; company: string; id: string }
  | { kind: "oracle"; host: string; site: string; id: string }
  | PageSourceTarget;
export type GitHubListResult = { items: DiscoveredItem[]; notes: string[] };

const SOURCES = {
  "simplifyjobs/summer2027-internships": { repository: "SimplifyJobs/Summer2027-Internships", format: "simplify", files: ["README.md"] },
  "vanshb03/summer2027-internships": { repository: "vanshb03/Summer2027-Internships", format: "vansh", files: [".github/scripts/listings.json"] },
  "speedyapply/2027-ai-college-jobs": { repository: "speedyapply/2027-AI-College-Jobs", format: "speedy", files: ["README.md", "INTERN_INTL.md"] },
  "northwesternfintech/2027quantinternships": { repository: "northwesternfintech/2027QuantInternships", format: "quant", files: ["README.md"] },
  "speedyapply/2027-swe-college-jobs": { repository: "speedyapply/2027-SWE-College-Jobs", format: "speedy", files: ["README.md", "INTERN_INTL.md"] }
} as const;
type SourceKey = keyof typeof SOURCES;
const MAX_INDEX_BYTES = 5_000_000;
const MAX_POSTING_BYTES = 5_000_000;
/** Postings resolved per check; INTERNSHIP_AGENT_DISCOVERY_MAX_POSTINGS overrides it. */
const DEFAULT_MAX_POSTINGS = 100;
/** Discovery ingests at most 100 items per batch, so a larger setting would be cut. */
const MAX_POSTINGS_CEILING = 100;
const REQUEST_DELAY_MS = 350;
/** At most one posting request per host per interval, on top of the global spacing. */
const HOST_INTERVAL_MS = 500;

const vanshRowSchema = z.object({
  company_name: z.string(), title: z.string(), url: z.string(),
  active: z.boolean().optional(), is_visible: z.boolean().optional(),
  date_posted: z.number().optional(),
  locations: z.array(z.string()).max(50).optional(), season: z.string().max(40).optional()
});
/** Vansh rows link through the list's own short-link host, one redirect from the board. */
const VANSH_SHORT_HOST = "go.vansh.nyc";
const greenhouseJobSchema = z.object({
  title: z.string(), absolute_url: z.url(), content: z.string().optional(), first_published: z.unknown().optional(),
  location: z.object({ name: z.string() }).optional(),
  /** The offices the job is filed under; each office's own location often names the country the location line leaves out. */
  offices: z.array(z.object({ name: z.string().nullish(), location: z.string().nullish() })).max(50).nullish()
});
const leverJobSchema = z.object({
  text: z.string(), hostedUrl: z.url(), descriptionPlain: z.string().optional(),
  description: z.string().optional(),
  /** ISO 3166 alpha-2 code of the posting's country. */
  country: z.string().nullish(),
  categories: z.object({ location: z.string().optional(), allLocations: z.array(z.string()).max(50).nullish() }).optional(),
  lists: z.array(z.object({ text: z.string(), content: z.string() })).optional()
});
const ashbyAddressSchema = z.object({
  postalAddress: z.object({
    addressLocality: z.string().nullish(), addressRegion: z.string().nullish(), addressCountry: z.string().nullish()
  }).nullish()
}).nullish();
const ashbyJobSchema = z.object({
  id: z.string(), title: z.string(), jobUrl: z.url(), publishedAt: z.unknown().optional(),
  isListed: z.boolean().optional(), descriptionPlain: z.string().optional(),
  descriptionHtml: z.string().optional(), location: z.string().optional(),
  address: ashbyAddressSchema,
  secondaryLocations: z.array(z.object({ location: z.string().nullish(), address: ashbyAddressSchema })).max(50).nullish()
});

const workdayJobSchema = z.object({
  jobPostingInfo: z.object({
    title: z.string(), jobDescription: z.string().optional(), location: z.string().optional(),
    startDate: z.unknown().optional(), externalUrl: z.url().optional(), canApply: z.boolean().optional(),
    country: z.object({ descriptor: z.string().optional() }).optional(),
    jobRequisitionLocation: z.object({ country: z.object({ descriptor: z.string().optional() }).optional() }).optional()
  })
});

/**
 * Workday's location is often a bare city ("Milan"), which the extractor never
 * reads as a country; the posting's own country descriptor joins it. Not for
 * "2 Locations": the primary country must not decide a multi-location posting.
 */
function workdayLocation(info: z.infer<typeof workdayJobSchema>["jobPostingInfo"]): string | undefined {
  const location = info.location?.trim();
  const country = (info.jobRequisitionLocation?.country?.descriptor ?? info.country?.descriptor)?.trim();
  if (!location || !country || /\blocations?\b/i.test(location)) return info.location;
  if (location.toLocaleLowerCase("en-US").includes(country.toLocaleLowerCase("en-US"))) return info.location;
  return location + ", " + country;
}
const WORKDAY_HOST = /^([a-z0-9-]+)\.wd\d{1,3}\.myworkdayjobs\.com$/;
const WORKDAY_LOCALE = /^[a-z]{2}-[A-Z]{2}$/;
const smartRecruitersSectionSchema = z.object({ title: z.string().optional(), text: z.string().optional() }).optional();
const smartRecruitersJobSchema = z.object({
  name: z.string(), releasedDate: z.unknown().optional(), postingUrl: z.url().optional(), active: z.boolean().optional(),
  location: z.object({ fullLocation: z.string().optional() }).optional(),
  jobAd: z.object({
    sections: z.object({
      jobDescription: smartRecruitersSectionSchema,
      qualifications: smartRecruitersSectionSchema,
      additionalInformation: smartRecruitersSectionSchema
    })
  })
});
// Only the External* fields are candidate-facing; Internal* copies are ignored.
const oracleJobSchema = z.object({
  items: z.array(z.object({
    Title: z.string(), PrimaryLocation: z.string().optional(),
    ExternalDescriptionStr: z.string().nullish(), ExternalResponsibilitiesStr: z.string().nullish(),
    ExternalPostedStartDate: z.unknown().optional(), ExternalQualificationsStr: z.string().nullish(), ExternalPostedEndDate: z.string().nullish()
  })).max(1)
});
const ORACLE_HOST = /^[a-z0-9-]+\.fa(\.[a-z0-9-]+)?\.oraclecloud\.com$/;

/**
 * The per-check budget scales with the posting limit: five listed links
 * scanned, 1.5 posting requests, and 4.5 seconds per posting (the original
 * 20 postings took 100 links, 30 requests, and 90 seconds).
 */
export function discoveryBudget(env: Record<string, string | undefined> = process.env): {
  maxPostings: number; maxListingsScanned: number; maxPostingRequests: number; maxFetchTimeMs: number;
} {
  const raw = env.INTERNSHIP_AGENT_DISCOVERY_MAX_POSTINGS?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : DEFAULT_MAX_POSTINGS;
  const maxPostings = Math.min(MAX_POSTINGS_CEILING, Math.max(1, parsed));
  return {
    maxPostings,
    maxListingsScanned: maxPostings * 5,
    maxPostingRequests: Math.ceil(maxPostings * 1.5),
    maxFetchTimeMs: maxPostings * 4_500
  };
}

/** The five candidate-selected repositories are the entire allowlist. */
export function parseGitHubJobListUrl(raw: string): SourceKey {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Enter a supported GitHub job-list URL."); }
  const parts = url.pathname.split("/").filter(Boolean);
  const key = parts.join("/").toLocaleLowerCase("en-US");
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password ||
    url.port || url.search || url.hash || parts.length !== 2 || !(key in SOURCES)) {
    throw new Error("Only the five selected GitHub job-list repositories are supported.");
  }
  return key as SourceKey;
}

export function canonicalGitHubJobListUrl(raw: string): string {
  return "https://github.com/" + SOURCES[parseGitHubJobListUrl(raw)].repository;
}

/**
 * A repository row is a lead, not a posting. Resolve only direct, public
 * Greenhouse, Lever (including Lever EU), Ashby, Workday, SmartRecruiters,
 * Oracle Cloud, Dover, iCIMS, Workable, and Rippling links, Greenhouse gh_jid
 * links on employer domains, and career pages carrying one schema.org
 * JobPosting to full descriptions before matching. `onRow` receives one
 * decision for every parsed row (the discovery trace); a failing callback
 * never stops the check.
 */
export async function fetchGitHubJobList(
  source: { url: string },
  fetcher: Fetcher = fetch,
  options: {
    /** Spacing between posting requests (350 ms); an explicit value also turns off host pacing unless hostIntervalMs is given. */
    delayMs?: number; maxItems?: number; maxPostingRequests?: number;
    /** Minimum spacing between posting requests to the same host (500 ms by default, 0 when delayMs is given). */
    hostIntervalMs?: number;
    /** Waits for the spacing above; tests replace it. */
    sleep?: Sleep;
    /** postingLinkKey values already in the workspace; they are never re-fetched. */
    knownLinkKeys?: ReadonlySet<string>;
    /** Overrides discoveryListFilter() (from the environment). */
    filter?: DiscoveryListFilter;
    now?: number;
    /** One decision per parsed row, as it is made. */
    onRow?: (event: DiscoveryRowEvent) => void;
  } = {}
): Promise<GitHubListResult> {
  const config = SOURCES[parseGitHubJobListUrl(source.url)];
  const delayMs = options.delayMs ?? REQUEST_DELAY_MS;
  const pause = options.sleep ?? waitFor;
  const hostIntervalMs = options.hostIntervalMs ?? (options.delayMs === undefined ? HOST_INTERVAL_MS : 0);
  // Posting requests share one per-host pacer; the GitHub index files use the raw fetcher.
  const postingFetcher = hostIntervalMs > 0 ? pacePerHost(fetcher, hostIntervalMs, { sleep: pause }) : fetcher;
  const budget = discoveryBudget();
  const filter = options.filter ?? discoveryListFilter();
  const now = options.now ?? Date.now();
  const maxItems = Math.min(budget.maxPostings, Math.max(1, options.maxItems ?? budget.maxPostings));
  const maxPostingRequests = Math.min(budget.maxPostingRequests, Math.max(1, options.maxPostingRequests ?? budget.maxPostingRequests));
  const deadline = Date.now() + budget.maxFetchTimeMs;
  const files: string[] = [];
  for (const path of config.files) {
    const response = await fetcher(
      "https://raw.githubusercontent.com/" + config.repository + "/HEAD/" + path,
      { redirect: "error", signal: AbortSignal.timeout(15_000) }
    );
    if (!response.ok) throw new Error("The GitHub job list answered " + response.status + ".");
    files.push(await boundedText(response, MAX_INDEX_BYTES));
  }
  const parsed: ParsedListing[] = config.format === "simplify" ? parseSimplify(files[0]!) :
    config.format === "vansh" ? parseVansh(files[0]!, now) :
    config.format === "quant" ? parseQuant(files[0]!) :
    files.flatMap((file, index) => parseSpeedy(file, index > 0));
  const listings: Listing[] = parsed.map((listing, index) => ({ ...listing, row: index + 1 }));
  const emit = (listing: Listing, decision: DiscoveryListDecision, reason: string, link = listing.url, postingUrl?: string) => {
    if (!options.onRow) return;
    let host = "";
    try { host = new URL(link).hostname; } catch { /* no host */ }
    try {
      options.onRow({
        row: listing.row, company: listing.companyName.slice(0, 200), title: listing.title.slice(0, 200),
        url: link.slice(0, 500), host, decision, reason: reason.slice(0, 300),
        ...(postingUrl !== undefined ? { postingUrl: postingUrl.slice(0, 500) } : {})
      });
    } catch { /* the trace never stops discovery */ }
  };
  const unique = new Set<string>();
  let known = 0;
  let stale = 0;
  let offSeason = 0;
  let unreadable = 0;
  // Known, stale, and off-season rows are dropped before the scan cap, so each check reaches new postings.
  const filtered: Listing[] = [];
  for (const row of listings) {
    if (row.rejected) {
      if (row.rejected.decision === "failed-to-parse") unreadable += 1;
      emit(row, row.rejected.decision, row.rejected.reason);
      continue;
    }
    if (!row.companyName || !row.title) { unreadable += 1; emit(row, "failed-to-parse", "the row names no company or title"); continue; }
    if (!validHttpsUrl(row.url)) { emit(row, "invalid-link", "the apply link is not a plain https link"); continue; }
    if (filter.maxAgeDays !== null && (row.ageDays === null || row.ageDays > filter.maxAgeDays)) {
      stale += 1;
      const limit = filter.maxAgeDays + " " + (filter.maxAgeDays === 1 ? "day" : "days");
      emit(row, "stale", row.ageDays === null
        ? "the list states no date while the age limit of " + limit + " is set"
        : "listed " + row.ageDays + " " + (row.ageDays === 1 ? "day" : "days") + " ago, past the age limit of " + limit);
      continue;
    }
    if (filter.season && row.season && row.season.toLocaleLowerCase("en-US") !== filter.season) {
      offSeason += 1;
      emit(row, "off-season", "listed for " + row.season + ", not the target's " + filter.season);
      continue;
    }
    const key = postingLinkKey(row.url);
    if (unique.has(key ?? row.url)) { emit(row, "duplicate-row", "the same posting is listed earlier in the list"); continue; }
    unique.add(key ?? row.url);
    if (key && options.knownLinkKeys?.has(key)) { known += 1; emit(row, "already-known", "already in the workspace; not fetched again"); continue; }
    filtered.push(row);
  }
  const candidates = filtered.slice(0, budget.maxListingsScanned);
  for (const row of filtered.slice(budget.maxListingsScanned)) {
    emit(row, "not-reached", "past this check's scan limit of " + budget.maxListingsScanned + " links; tried again on the next check");
  }

  const ashbyBoards = new Map<string, z.infer<typeof ashbyJobSchema>[]>();
  const items: DiscoveredItem[] = [];
  let unsupported = 0;
  let unavailable = 0;
  const unsupportedHosts = new Map<string, number>();
  const unavailableReasons = new Map<string, number>();
  let requests = 0;
  let scanned = 0;
  let stoppedForTime = false;
  const itemsLimitReason = "this check's posting limit of " + maxItems + " was reached; tried again on the next check";
  const requestsReason = "this check's posting-request budget of " + maxPostingRequests + " was reached; tried again on the next check";
  const timeReason = "this check's time limit was reached; tried again on the next check";
  let stopIndex = candidates.length;
  let stopReason = "";
  for (let index = 0; index < candidates.length; index += 1) {
    const listing = candidates[index]!;
    if (items.length >= maxItems) { stopIndex = index; stopReason = itemsLimitReason; break; }
    if (requests >= maxPostingRequests) { stopIndex = index; stopReason = requestsReason; break; }
    if (Date.now() >= deadline) { stoppedForTime = true; stopIndex = index; stopReason = timeReason; break; }
    scanned += 1;
    let link = listing.url;
    if (new URL(link).hostname === VANSH_SHORT_HOST) {
      if (requests >= maxPostingRequests) { stopIndex = index; stopReason = requestsReason; break; }
      requests += 1;
      const resolved = await followShortLink(link, postingFetcher);
      if (!resolved) {
        unavailable += 1;
        tally(unavailableReasons, "the list's short link did not resolve");
        emit(listing, "unavailable", "the list's short link did not resolve");
        continue;
      }
      link = resolved;
      const key = postingLinkKey(link);
      if (key && (options.knownLinkKeys?.has(key) || unique.has(key))) {
        known += 1;
        if (options.knownLinkKeys?.has(key)) emit(listing, "already-known", "already in the workspace; not fetched again", link);
        else emit(listing, "duplicate-row", "the same posting is listed earlier in the list", link);
        continue;
      }
      if (key) unique.add(key);
    }
    const target = identifyBoard(link);
    if (!target) {
      unsupported += 1;
      const host = new URL(link).hostname;
      tally(unsupportedHosts, host);
      emit(listing, "unsupported", "no supported full-posting source for " + host, link);
      continue;
    }
    if (requests >= maxPostingRequests) { stopIndex = index; stopReason = requestsReason; break; }
    if (requests > 0 && delayMs > 0) await pause(delayMs);
    requests += 1;
    try {
      const posting = await resolvePosting(target, postingFetcher, ashbyBoards, { companyName: listing.companyName });
      if (!posting || !validHttpsUrl(posting.url) || posting.text.length < 200 || posting.text.length > 60_000) {
        unavailable += 1;
        const reason = !posting ? "closed, unlisted, or without a description" :
          !validHttpsUrl(posting.url) ? "no usable posting URL" :
          posting.text.length < 200 ? "description too short" : "description too long";
        tally(unavailableReasons, reason);
        emit(listing, "unavailable", reason, link);
        continue;
      }
      // The board's own location wins; the list's column fills in, labelled as such, only when the
      // board states none or names no place the extractor can read ("Hybrid").
      const boardPlaces = posting.text.split("\n\n", 1)[0]!.split("\n")
        .filter((line) => /^(?:Location|Office): /.test(line)).map((line) => line.replace(/^(?:Location|Office): /, ""));
      const text = listing.location && boardPlaces.every((place) => locationCountryCodes(place).length === 0)
        ? "Job list location: " + listing.location.slice(0, 300) + "\n\n" + posting.text
        : posting.text;
      items.push(discoveredItemSchema.parse({
        title: posting.title || listing.title,
        companyName: listing.companyName,
        text: text.slice(0, 60_000),
        sourceUrl: posting.url,
        publication: posting.publication ?? null
      }));
      emit(listing, "resolved", "full posting read", link, posting.url);
    } catch (error) {
      unavailable += 1;
      const reason = unavailableReason(error);
      tally(unavailableReasons, reason);
      emit(listing, "unavailable", reason, link);
    }
  }
  for (const listing of candidates.slice(stopIndex)) emit(listing, "not-reached", stopReason);
  const notes = [
    known + " listed " + (known === 1 ? "link was" : "links were") + " already in the workspace and not fetched again.",
    "Scanned " + scanned + " listed internship links from " + config.repository + ".",
    unsupported + " " + (unsupported === 1 ? "link needs" : "links need") + " manual review because " +
      (unsupported === 1 ? "it has" : "they have") + " no supported full-posting API.",
    unavailable + " public " + (unavailable === 1 ? "posting was" : "postings were") +
      " unavailable or lacked a usable description."
  ];
  if (filter.maxAgeDays !== null) {
    notes.push(stale + " listed " + (stale === 1 ? "row was" : "rows were") + " older than " + filter.maxAgeDays +
      " " + (filter.maxAgeDays === 1 ? "day" : "days") + " or undated and skipped.");
  }
  if (offSeason > 0) notes.push(offSeason + " listed " + (offSeason === 1 ? "row was" : "rows were") + " for another season and skipped.");
  if (unreadable > 0) {
    notes.push(unreadable + " listed " + (unreadable === 1 ? "row" : "rows") + " could not be read and " +
      (unreadable === 1 ? "was" : "were") + " skipped.");
  }
  if (stoppedForTime) notes.push("The check stopped at its " + Math.round(budget.maxFetchTimeMs / 1000) + "-second time limit.");
  if (unsupportedHosts.size > 0) notes.push("Manual review, no supported full-posting source: " + top(unsupportedHosts, 8) + ".");
  if (unavailableReasons.size > 0) notes.push("Unavailable postings stay for manual review: " + top(unavailableReasons, 6) + ".");
  // With known (or filtered) links skipped, finding nothing new is an ordinary outcome.
  if (items.length === 0 && known === 0 && stale === 0 && offSeason === 0) throw new Error("No full public postings were resolved. " + notes.join(" "));
  return { items, notes };
}

function tally(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** "key count" entries by count, then key; the rest summed as "others". */
function top(counts: Map<string, number>, limit: number): string {
  const entries = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const shown = entries.slice(0, limit).map(([key, count]) => key + " " + count).join(", ");
  const others = entries.slice(limit).reduce((sum, [, count]) => sum + count, 0);
  return entries.length > limit ? shown + ", others " + others : shown;
}

function unavailableReason(error: unknown): string {
  if (error instanceof PostingUnavailable) return error.reason;
  if (error instanceof z.ZodError) return "unexpected response shape";
  if (error instanceof SyntaxError) return "unreadable response";
  const message = error instanceof Error ? error.message : "";
  const status = /answered (\d{3})/.exec(message)?.[1];
  if (status) return "HTTP " + status;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timed out";
  return "request failed";
}

export type DiscoveryListFilter = {
  /** Rows listed longer ago than this, or undated, are skipped; null keeps every row. */
  maxAgeDays: number | null;
  /** Lowercase season ("summer"); rows whose list states another season are skipped. */
  season: string | null;
};

/**
 * INTERNSHIP_AGENT_DISCOVERY_MAX_AGE_DAYS (1–365) keeps only freshly listed
 * rows; INTERNSHIP_AGENT_TARGET_TERM (for example summer-2027) also skips
 * rows a list labels with another season. Unset, every row is kept.
 */
export function discoveryListFilter(env: Record<string, string | undefined> = process.env): DiscoveryListFilter {
  const raw = env.INTERNSHIP_AGENT_DISCOVERY_MAX_AGE_DAYS?.trim();
  const days = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
  const season = /^(summer|fall|winter|spring)-\d{4}$/i.exec(env.INTERNSHIP_AGENT_TARGET_TERM?.trim() ?? "")?.[1];
  return { maxAgeDays: days !== null && days >= 1 ? Math.min(365, days) : null, season: season ? season.toLocaleLowerCase("en-US") : null };
}

/** "0d", "3d", "2w", "1mo", "5h": the list's Age column in whole days. */
function listedAgeDays(cell: string | undefined): number | null {
  const match = /^(\d{1,4})\s*(h|d|w|mo)$/i.exec(stripMarkup(cell ?? ""));
  if (!match) return null;
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toLocaleLowerCase("en-US");
  return unit === "h" ? 0 : unit === "d" ? amount : unit === "w" ? amount * 7 : amount * 30;
}

/** One redirect, read without following it; only an https board link counts. */
async function followShortLink(url: string, fetcher: Fetcher): Promise<string | null> {
  try {
    const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    await response.body?.cancel();
    if (!location) return null;
    const target = new URL(location, url).toString();
    return validHttpsUrl(target) ? target : null;
  } catch { return null; }
}

const CLOSED_ON_LIST = "no apply link on the list (closed)";

function parseSimplify(readme: string): ParsedListing[] {
  const rows: ParsedListing[] = [];
  let companyName = "";
  for (const match of readme.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]!);
    if (cells.length < 4) continue;
    const company = stripMarkup(cells[0]!);
    if (company && company !== "↳") companyName = company.replace(/^🔥\s*/, "");
    const title = stripMarkup(cells[1]!);
    const url = firstLink(cells[3]!);
    if (!companyName && !title) continue;
    const row = { companyName, title, url: url ?? "", ageDays: listedAgeDays(cells[4]), location: stripMarkup(cells[2]!) || null, season: null };
    if (!companyName) rows.push({ ...row, rejected: { decision: "failed-to-parse", reason: "the row names no company" } });
    else if (!url) rows.push({ ...row, rejected: { decision: "closed", reason: CLOSED_ON_LIST } });
    else if (!isInternshipTitle(title)) rows.push({ ...row, rejected: { decision: "not-internship", reason: "the title is not an internship" } });
    else rows.push(row);
  }
  return rows;
}

/** One malformed row is skipped with its reason; it no longer discards the whole list. */
function parseVansh(raw: string, now: number): ParsedListing[] {
  const entries = z.array(z.unknown()).max(10_000).parse(JSON.parse(raw) as unknown);
  const valid: Array<z.infer<typeof vanshRowSchema>> = [];
  const failed: ParsedListing[] = [];
  for (const entry of entries) {
    const parsed = vanshRowSchema.safeParse(entry);
    if (parsed.success) { valid.push(parsed.data); continue; }
    const fields = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const field = (name: string) => typeof fields[name] === "string" ? fields[name] : "";
    failed.push({
      companyName: field("company_name"), title: field("title"), url: field("url"), ageDays: null, location: null, season: null,
      rejected: { decision: "failed-to-parse", reason: "the row does not match the list's format" }
    });
  }
  const rows = valid.sort((a, b) => (b.date_posted ?? 0) - (a.date_posted ?? 0))
    .map((row): ParsedListing => {
      const listing: ParsedListing = {
        companyName: row.company_name, title: row.title, url: row.url,
        // date_posted is in seconds; a future stamp counts as listed today.
        ageDays: row.date_posted ? Math.max(0, Math.floor((now - row.date_posted * 1000) / 86_400_000)) : null,
        location: row.locations?.length ? row.locations.join("; ") : null,
        season: row.season?.trim() || null
      };
      if (row.active === false || row.is_visible === false) {
        return { ...listing, rejected: { decision: "closed", reason: "marked inactive or hidden on the list" } };
      }
      if (!isInternshipTitle(row.title)) return { ...listing, rejected: { decision: "not-internship", reason: "the title is not an internship" } };
      return listing;
    });
  return [...rows, ...failed];
}

function parseSpeedy(readme: string, internshipOnlyFile: boolean): ParsedListing[] {
  const rows: ParsedListing[] = [];
  for (const line of readme.split(/\r?\n/)) {
    if (!line.startsWith("|") || /^\|\s*:?-{3,}/.test(line)) continue;
    const cells = line.split("|").slice(1, -1);
    if (cells.length < 5) continue;
    const companyName = stripMarkup(cells[0]!);
    const title = stripMarkup(cells[1]!);
    const url = firstLink(cells[4]!) ?? firstLink(cells[cells.length - 2]!);
    const row = { companyName, title, url: url ?? "", ageDays: listedAgeDays(cells[cells.length - 1]), location: stripMarkup(cells[2]!) || null, season: null };
    if (!url) {
      if (internshipOnlyFile || isInternshipTitle(title)) rows.push({ ...row, rejected: { decision: "closed", reason: CLOSED_ON_LIST } });
      continue;
    }
    if (!companyName || !title) rows.push({ ...row, rejected: { decision: "failed-to-parse", reason: "the row names no company or title" } });
    else if (!internshipOnlyFile && !isInternshipTitle(title)) {
      rows.push({ ...row, rejected: { decision: "not-internship", reason: "the title is not an internship" } });
    } else rows.push(row);
  }
  return rows;
}

function parseQuant(readme: string): ParsedListing[] {
  const rows: ParsedListing[] = [];
  let companyName = "";
  for (const line of readme.split(/\r?\n/)) {
    if (line.startsWith("## ") && !line.startsWith("## Contributing") && !line.startsWith("## Using")) {
      companyName = stripMarkup(line.slice(3));
      continue;
    }
    if (!companyName || !line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1);
    if (cells.length < 2 || !/^[A-Z]{2,5}$/.test((cells[0] ?? "").trim())) continue;
    const role = cells[0]!.trim();
    for (const link of cells[1]!.matchAll(/\[[^\]]*\]\((https:\/\/[^)]+)\)/g)) {
      rows.push({ companyName, title: role + " Internship", url: decodeUrl(link[1]!), ageDays: null, location: null, season: null });
    }
  }
  return rows;
}

/**
 * A stable posting identity shared by a listing link and the URL stored for
 * the resolved posting (which may drop a locale, tracking, or title slug).
 */
export function postingLinkKey(raw: string): string | null {
  const target = identifyBoard(raw);
  if (target?.kind === "greenhouse") return "greenhouse:" + target.id;
  if (target?.kind === "lever") return ("lever:" + target.slug + "/" + target.id).toLowerCase();
  if (target?.kind === "ashby") return "ashby:" + target.id.toLowerCase();
  if (target?.kind === "workday") return ("workday:" + target.host + "/" + target.site + "/" + target.path).toLowerCase();
  if (target?.kind === "smartrecruiters") return "smartrecruiters:" + target.id;
  if (target?.kind === "oracle") return "oracle:" + target.host + ":" + target.id;
  if (target && isPageSourceTarget(target)) return pageSourceKey(target);
  // Greenhouse boards embedded on employer domains carry the job id as gh_jid.
  try {
    const id = new URL(raw).searchParams.get("gh_jid");
    return id && /^\d+$/.test(id) ? "greenhouse:" + id : null;
  } catch { return null; }
}

function identifyBoard(raw: string): BoardTarget | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if ((url.hostname === "boards.greenhouse.io" || url.hostname === "job-boards.greenhouse.io") &&
    parts.length >= 3 && parts[1] === "jobs" && /^\d+$/.test(parts[2]!)) {
    return { kind: "greenhouse", slug: parts[0]!, id: parts[2]! };
  }
  if ((url.hostname === "jobs.lever.co" || url.hostname === "jobs.eu.lever.co") && parts.length >= 2) {
    return { kind: "lever", slug: parts[0]!, id: parts[1]!, eu: url.hostname === "jobs.eu.lever.co" };
  }
  if (url.hostname === "jobs.ashbyhq.com" && parts.length >= 2) {
    return { kind: "ashby", slug: parts[0]!, id: parts[1]! };
  }
  const tenant = WORKDAY_HOST.exec(url.hostname)?.[1];
  if (tenant) {
    // Career-site links are /{site}/job/... with an optional leading locale.
    const rest = WORKDAY_LOCALE.test(parts[0] ?? "") ? parts.slice(1) : parts;
    if (rest.length >= 3 && rest[1] === "job") {
      return { kind: "workday", host: url.hostname, tenant, site: rest[0]!, path: rest.slice(2).join("/") };
    }
  }
  const postingId = /^(\d+)(?:-|$)/.exec(parts[1] ?? "")?.[1];
  if (url.hostname === "jobs.smartrecruiters.com" && parts.length === 2 && /^[A-Za-z0-9_-]+$/.test(parts[0]!) && postingId) {
    return { kind: "smartrecruiters", company: parts[0]!, id: postingId };
  }
  // Candidate Experience links are /hcmUI/CandidateExperience/{lang}/sites/{site}/job/{id}.
  if (ORACLE_HOST.test(url.hostname) && parts.length >= 7 && parts[0] === "hcmUI" &&
    parts[1] === "CandidateExperience" && parts[3] === "sites" && /^[A-Za-z0-9_]+$/.test(parts[4]!) &&
    parts[5] === "job" && /^\d+$/.test(parts[6]!)) {
    return { kind: "oracle", host: url.hostname, site: parts[4]!, id: parts[6]! };
  }
  return identifyPageSource(url);
}

async function resolvePosting(
  target: BoardTarget,
  fetcher: Fetcher,
  ashbyBoards: Map<string, z.infer<typeof ashbyJobSchema>[]>,
  context: { companyName: string } = { companyName: "" }
): Promise<ResolvedPosting | null> {
  if (isPageSourceTarget(target)) return resolvePageSource(target, fetcher, context);
  if (target.kind === "greenhouse") {
    const job = greenhouseJobSchema.parse(await fetchJson(
      "https://boards-api.greenhouse.io/v1/boards/" + encodeURIComponent(target.slug) +
      "/jobs/" + encodeURIComponent(target.id) + "?content=true", fetcher
    ));
    if (!job.content) return null;
    return { title: job.title, url: job.absolute_url, publication: employerPublication(job.first_published, job.absolute_url, "first_published"), text: withLocation(job.location?.name, plainText(job.content), greenhouseOfficeLine(job)) };
  }
  if (target.kind === "lever") {
    const job = leverJobSchema.parse(await fetchJson(
      (target.eu ? "https://api.eu.lever.co" : "https://api.lever.co") + "/v0/postings/" + encodeURIComponent(target.slug) + "/" + encodeURIComponent(target.id), fetcher
    ));
    const lists = (job.lists ?? []).map((list) => list.text + ":\n" + plainText(list.content)).join("\n\n");
    const body = job.descriptionPlain ?? plainText(job.description ?? "");
    return { title: job.text, url: job.hostedUrl, text: withLocation(leverLocation(job), body + "\n\n" + lists) };
  }
  if (target.kind === "workday") {
    // The career site's own public JSON endpoint; no sign-in is involved.
    const info = workdayJobSchema.parse(await fetchJson(
      "https://" + target.host + "/wday/cxs/" + encodeURIComponent(target.tenant) + "/" +
      encodeURIComponent(target.site) + "/job/" + target.path, fetcher
    )).jobPostingInfo;
    if (info.canApply === false || !info.jobDescription) return null;
    const canonical = "https://" + target.host + "/" + target.site + "/job/" + target.path;
    const url = info.externalUrl && new URL(info.externalUrl).hostname === target.host ? info.externalUrl : canonical;
    return { title: info.title, url, publication: employerPublication(info.startDate, url, "startDate"), text: withLocation(workdayLocation(info), plainText(info.jobDescription)) };
  }
  if (target.kind === "smartrecruiters") {
    const job = smartRecruitersJobSchema.parse(await fetchJson(
      "https://api.smartrecruiters.com/v1/companies/" + encodeURIComponent(target.company) +
      "/postings/" + encodeURIComponent(target.id), fetcher
    ));
    if (job.active === false) return null;
    const { jobDescription, qualifications, additionalInformation } = job.jobAd.sections;
    const body = sections([jobDescription, qualifications, additionalInformation]
      .map((section) => [section?.title ?? "", section?.text ?? ""] as const));
    const canonical = "https://jobs.smartrecruiters.com/" + target.company + "/" + target.id;
    const url = job.postingUrl && new URL(job.postingUrl).hostname === "jobs.smartrecruiters.com" ? job.postingUrl : canonical;
    return body ? { title: job.name, url, publication: employerPublication(job.releasedDate, url, "releasedDate"), text: withLocation(job.location?.fullLocation, body) } : null;
  }
  if (target.kind === "oracle") {
    const job = oracleJobSchema.parse(await fetchJson(
      "https://" + target.host + "/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails" +
      "?onlyData=true&finder=ById;Id=%22" + target.id + "%22,siteNumber=" + encodeURIComponent(target.site), fetcher
    )).items[0];
    if (!job) return null;
    const endsAt = job.ExternalPostedEndDate ? Date.parse(job.ExternalPostedEndDate) : NaN;
    if (Number.isFinite(endsAt) && endsAt < Date.now()) return null;
    const body = sections([
      ["", job.ExternalDescriptionStr ?? ""],
      ["Responsibilities", job.ExternalResponsibilitiesStr ?? ""],
      ["Qualifications", job.ExternalQualificationsStr ?? ""]
    ]);
    const url = "https://" + target.host + "/hcmUI/CandidateExperience/en/sites/" + target.site + "/job/" + target.id;
    return body ? { title: job.Title, url, publication: employerPublication(job.ExternalPostedStartDate, url, "ExternalPostedStartDate"), text: withLocation(job.PrimaryLocation, body) } : null;
  }
  if (!ashbyBoards.has(target.slug)) {
    const payload = z.object({ jobs: z.array(ashbyJobSchema).max(2_000) }).parse(await fetchJson(
      "https://api.ashbyhq.com/posting-api/job-board/" + encodeURIComponent(target.slug), fetcher
    ));
    ashbyBoards.set(target.slug, payload.jobs);
  }
  const job = ashbyBoards.get(target.slug)!.find((entry) => entry.id === target.id && entry.isListed !== false);
  if (!job) return null;
  return {
    title: job.title,
    url: job.jobUrl,
    publication: employerPublication(job.publishedAt, job.jobUrl, "publishedAt"),
    text: withLocation(ashbyLocation(job), job.descriptionPlain ?? plainText(job.descriptionHtml ?? ""))
  };
}

/** Joins titled HTML sections, keeping each heading so the extractor sees it. */
function sections(parts: ReadonlyArray<readonly [string, string]>): string {
  return parts.map(([title, html]) => [title, plainText(html)] as const)
    .filter(([, text]) => text.length > 0)
    .map(([title, text]) => (title ? title + ":\n" : "") + text)
    .join("\n\n");
}

async function fetchJson(url: string, fetcher: Fetcher): Promise<unknown> {
  const response = await fetcher(url, {
    redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { accept: "application/json", "user-agent": POSTING_USER_AGENT }
  });
  if (!response.ok) throw new Error("The public posting API answered " + response.status + ".");
  return JSON.parse(await boundedText(response, MAX_POSTING_BYTES)) as unknown;
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error("The public source returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("The public source response is too large to process safely.");
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

function isInternshipTitle(title: string): boolean {
  return /\b(intern(ship)?|co-op)\b/i.test(title);
}

function validHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.port;
  } catch { return false; }
}

function firstLink(value: string): string | null {
  const href = /href=["']([^"']+)["']/i.exec(value)?.[1];
  const markdown = /\[[^\]]*\]\((https:\/\/[^)]+)\)/.exec(value)?.[1];
  return href || markdown ? decodeUrl((href ?? markdown)!) : null;
}

function decodeUrl(url: string): string {
  return url.replace(/&amp;/gi, "&");
}

function stripMarkup(value: string): string {
  return plainText(value).replace(/[*_]/g, "").replace(/\s+/g, " ").trim();
}

/** Public date refresh reuses the same bounded, allowlisted posting resolver. */
export async function fetchEmployerPublication(
  url: string, fetcher: Fetcher = fetch,
  ashbyBoards: Map<string, z.infer<typeof ashbyJobSchema>[]> = new Map()
): Promise<PostingPublication | null> {
  const target = identifyBoard(url);
  if (!target || target.kind === "lever" || isPageSourceTarget(target)) return null;
  return (await resolvePosting(target, fetcher, ashbyBoards))?.publication ?? null;
}
