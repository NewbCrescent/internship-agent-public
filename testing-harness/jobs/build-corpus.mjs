/**
 * Builds the local posting corpus the Milestone 3 acceptance check reads.
 *
 * The listing repositories this reads are indexes, not postings: each row
 * carries a company, a title, a location and a link, but no requirements or
 * qualifications text. Posting text is therefore resolved from the public,
 * documented job-board APIs those links point at:
 *
 *   Greenhouse  https://developers.greenhouse.io/job-board.html
 *   Lever       https://github.com/lever/postings-api
 *   Ashby       https://developers.ashbyhq.com/docs/public-job-posting-api
 *
 * Only published, publicly readable postings are fetched, at a deliberate
 * pace. Nothing is scraped around a login, a paywall or a bot check: a link
 * that does not resolve through one of these APIs is skipped and reported.
 *
 * Output lands in the Git-ignored corpus directory. Posting text is
 * third-party content and is never committed.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const USER_AGENT = "internship-agent-corpus/0.1 (local milestone-3 acceptance corpus)";
const REQUEST_DELAY_MS = 350;
const DEFAULT_LIMIT = 20;
const DEFAULT_OUT = "data/job-postings";

const FEEDS = [
  {
    id: "simplify",
    repository: "SimplifyJobs/Summer2027-Internships",
    load: () => loadListingsJson("SimplifyJobs/Summer2027-Internships")
  },
  {
    id: "vanshb03",
    repository: "vanshb03/Summer2027-Internships",
    load: () => loadListingsJson("vanshb03/Summer2027-Internships")
  },
  {
    id: "speedyapply-swe",
    repository: "speedyapply/2027-SWE-College-Jobs",
    load: () => loadReadmeTable("speedyapply/2027-SWE-College-Jobs")
  },
  {
    id: "speedyapply-ai",
    repository: "speedyapply/2027-AI-College-Jobs",
    load: () => loadReadmeTable("speedyapply/2027-AI-College-Jobs")
  },
  {
    id: "northwestern-quant",
    repository: "northwesternfintech/2027QuantInternships",
    load: () => loadNorthwesternYaml("northwesternfintech/2027QuantInternships")
  }
];

await main();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDirectory = resolve(options.out);
  mkdirSync(outputDirectory, { recursive: true });

  const written = [];
  const skipped = [];
  const ashbyBoards = new Map();
  const seenUrls = new Set();

  for (const feed of FEEDS) {
    let rows = [];
    try {
      rows = await feed.load();
    } catch (error) {
      skipped.push({ feed: feed.id, reason: `feed unavailable: ${message(error)}` });
      continue;
    }

    let takenFromFeed = 0;
    for (const row of rows) {
      if (written.length >= options.limit) break;
      if (takenFromFeed >= options.perFeed) break;
      if (!row.url || seenUrls.has(row.url)) continue;
      seenUrls.add(row.url);

      const target = identifyBoard(row.url);
      if (!target) {
        skipped.push({ feed: feed.id, url: row.url, reason: "no public job-board API for this host" });
        continue;
      }

      try {
        const posting = await resolvePosting(target, ashbyBoards);
        if (!posting || posting.content.trim().length < 400) {
          skipped.push({ feed: feed.id, url: row.url, reason: "posting returned no usable description" });
          continue;
        }
        // One posting is often listed by several feeds under different links.
        const canonical = posting.sourceUrl || row.url;
        if (seenUrls.has(canonical)) {
          skipped.push({ feed: feed.id, url: row.url, reason: "duplicate of a posting already written" });
          continue;
        }
        seenUrls.add(canonical);

        const entry = {
          companyName: row.companyName || posting.companyName || target.org,
          title: posting.title || row.title,
          sourceUrl: posting.sourceUrl || row.url,
          externalApplicationUrl: null,
          companyCareersUrl: row.companyUrl || null,
          content: posting.content,
          // Provenance: which index listed it, and which API returned the text.
          feedRepository: feed.repository,
          resolvedVia: target.board,
          retrievedAt: new Date().toISOString()
        };

        const name = `${feed.id}-${slug(entry.companyName)}-${slug(entry.title)}`.slice(0, 80)
          + `-${shortHash(entry.sourceUrl)}`;
        writeFileSync(`${outputDirectory}/${name}.json`, `${JSON.stringify(entry, null, 2)}\n`);
        written.push({ file: `${name}.json`, feed: feed.id, board: target.board, chars: entry.content.length });
        takenFromFeed += 1;
      } catch (error) {
        skipped.push({ feed: feed.id, url: row.url, reason: message(error) });
      }
      await delay(REQUEST_DELAY_MS);
    }
  }

  const byBoard = tally(written.map((item) => item.board));
  const byFeed = tally(written.map((item) => item.feed));
  process.stdout.write(`JOB_CORPUS_BUILD_REPORT ${JSON.stringify({
    schemaVersion: 1,
    outputDirectory,
    written: written.length,
    byFeed,
    byBoard,
    skipped: skipped.length,
    skipReasons: tally(skipped.map((item) => item.reason.slice(0, 60))),
    files: written
  })}\n`);

  if (written.length === 0) {
    process.stderr.write("No postings could be resolved. Nothing was written.\n");
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* Feed loaders                                                        */
/* ------------------------------------------------------------------ */

async function loadListingsJson(repository) {
  const listings = await fetchJson(raw(repository, ".github/scripts/listings.json"));
  return listings
    .filter((row) => row.active !== false && row.is_visible !== false)
    .filter((row) => mentions2027(row))
    .sort((left, right) => (right.date_posted ?? 0) - (left.date_posted ?? 0))
    .map((row) => ({
      companyName: row.company_name,
      title: row.title,
      url: row.url,
      companyUrl: row.company_url || null
    }));
}

function mentions2027(row) {
  const terms = Array.isArray(row.terms) ? row.terms.join(" ") : "";
  return `${terms} ${row.season ?? ""} ${row.title ?? ""}`.includes("2027") || terms === "";
}

async function loadReadmeTable(repository) {
  const readme = await fetchText(raw(repository, "README.md"));
  const rows = [];
  for (const line of readme.split("\n")) {
    if (!line.startsWith("|") || line.includes("---")) continue;
    const cells = line.split("|").slice(1, -1);
    if (cells.length < 5) continue;
    const companyName = stripTags(cells[0]);
    const title = stripTags(cells[1]);
    const companyUrl = firstHref(cells[0]);
    const url = firstHref(cells[4]) ?? firstHref(cells[cells.length - 2]);
    if (!companyName || !title || !url) continue;
    rows.push({ companyName, title, url, companyUrl });
  }
  return rows;
}

async function loadNorthwesternYaml(repository) {
  const tree = await fetchJson(`https://api.github.com/repos/${repository}/git/trees/HEAD?recursive=1`);
  const files = (tree.tree ?? []).filter((entry) => entry.path.startsWith("data/") && entry.path.endsWith(".yaml"));
  const rows = [];
  for (const file of files) {
    const text = await fetchText(raw(repository, file.path));
    const companyName = /^name:\s*"?([^"\n]+)"?/m.exec(text)?.[1]?.trim();
    const website = /^website:\s*"?([^"\n]+)"?/m.exec(text)?.[1]?.trim() ?? null;
    if (!companyName) continue;
    let roleType = null;
    for (const line of text.split("\n")) {
      const role = /role_type:\s*"?([A-Za-z ]+)"?/.exec(line);
      if (role) roleType = role[1].trim();
      const url = /url:\s*"?(https?:\/\/[^"\s]+)"?/.exec(line);
      if (url) {
        rows.push({
          companyName,
          title: roleType ? `${roleType} Internship` : "Internship",
          url: url[1],
          companyUrl: website
        });
      }
    }
    await delay(60);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Job-board resolution                                                */
/* ------------------------------------------------------------------ */

function identifyBoard(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean);

  if (host.endsWith("greenhouse.io")) {
    const jobsIndex = segments.indexOf("jobs");
    if (jobsIndex > 0 && segments[jobsIndex + 1]) {
      return { board: "greenhouse", org: segments[jobsIndex - 1], id: segments[jobsIndex + 1] };
    }
    return null;
  }
  if (host.endsWith("ashbyhq.com") && segments.length >= 2) {
    return { board: "ashby", org: segments[0], id: segments[1] };
  }
  if (host.endsWith("lever.co") && segments.length >= 2) {
    return { board: "lever", org: segments[0], id: segments[1] };
  }
  // A company-hosted page that embeds a Greenhouse board exposes ?gh_jid=.
  const ghJid = parsed.searchParams.get("gh_jid");
  if (ghJid) {
    return { board: "greenhouse", org: host.split(".")[0], id: ghJid };
  }
  return null;
}

async function resolvePosting(target, ashbyBoards) {
  if (target.board === "greenhouse") {
    const job = await fetchJson(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.org)}`
      + `/jobs/${encodeURIComponent(target.id)}?content=true`
    );
    if (!job?.content) return null;
    // Greenhouse returns the location outside the description body, so it has
    // to be reattached or the posting would appear to state no location.
    return {
      title: job.title?.trim(),
      companyName: null,
      sourceUrl: job.absolute_url,
      content: `${locationLine(job.location?.name)}${htmlToText(job.content)}`
    };
  }

  if (target.board === "lever") {
    const job = await fetchJson(
      `https://api.lever.co/v0/postings/${encodeURIComponent(target.org)}/${encodeURIComponent(target.id)}`
    );
    const body = job?.descriptionPlain
      ? `${job.descriptionPlain}\n${leverListsToText(job.lists)}`
      : htmlToText(job?.description ?? "") + leverListsToText(job?.lists);
    if (!body.trim()) return null;
    return {
      title: job.text?.trim(),
      companyName: null,
      sourceUrl: job.hostedUrl ?? null,
      content: `${locationLine(job?.categories?.location)}${body}`
    };
  }

  if (target.board === "ashby") {
    if (!ashbyBoards.has(target.org)) {
      const board = await fetchJson(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(target.org)}?includeCompensation=true`
      ).catch(() => ({ jobs: [] }));
      ashbyBoards.set(target.org, board?.jobs ?? []);
    }
    const job = ashbyBoards.get(target.org).find((item) => item.id === target.id);
    if (!job?.descriptionPlain) return null;
    return {
      title: job.title?.trim(),
      companyName: null,
      sourceUrl: job.jobUrl ?? null,
      content: `${locationLine(job.location)}${compensationLine(job.compensation)}${job.descriptionPlain}`
    };
  }

  return null;
}

/**
 * Lever keeps requirements in structured `lists` rather than the prose body,
 * so dropping them would discard exactly the content this corpus exists to
 * exercise.
 */
function leverListsToText(lists) {
  if (!Array.isArray(lists)) return "";
  return lists
    .map((list) => `\n\n${stripTags(list.text ?? "")}:\n${htmlToText(list.content ?? "")}`)
    .join("");
}

function locationLine(location) {
  return location ? `Location: ${String(location).trim()}\n\n` : "";
}

function compensationLine(compensation) {
  const summary = compensation?.compensationTierSummary ?? compensation?.summaryComponents?.[0]?.summary;
  return summary ? `Compensation: ${summary}\n\n` : "";
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

/** Preserves list and block structure; the normalizer relies on bullets. */
function htmlToText(input) {
  return decodeEntities(input)
    .replace(/<\s*(script|style)[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|li|tr|section|header)\s*>/gi, "\n")
    .replace(/<\s*(p|div|h[1-6]|ul|ol|tr|section|header)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => decodeEntities(line).replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(input) {
  return String(input)
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, "&");
}

function stripTags(input) {
  return decodeEntities(String(input).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function firstHref(cell) {
  return /href="([^"]+)"/.exec(cell ?? "")?.[1] ?? null;
}

/** Keeps near-identical titles from overwriting one another's file. */
function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "posting";
}

/* ------------------------------------------------------------------ */
/* Fetch and CLI                                                       */
/* ------------------------------------------------------------------ */

function raw(repository, path) {
  return `https://raw.githubusercontent.com/${repository}/HEAD/${path}`;
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchWithTimeout(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json, text/plain, */*",
        ...(process.env.GITHUB_TOKEN && url.includes("api.github.com")
          ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(args) {
  const options = { limit: DEFAULT_LIMIT, perFeed: 6, out: process.env.INTERNSHIP_AGENT_POSTING_CORPUS || DEFAULT_OUT };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--limit") options.limit = Number.parseInt(args[++index], 10);
    else if (args[index] === "--per-feed") options.perFeed = Number.parseInt(args[++index], 10);
    else if (args[index] === "--out") options.out = args[++index];
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (!Number.isFinite(options.limit) || options.limit < 1) throw new Error("--limit must be a positive integer.");
  if (!Number.isFinite(options.perFeed) || options.perFeed < 1) throw new Error("--per-feed must be a positive integer.");
  return options;
}

function tally(values) {
  return values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
