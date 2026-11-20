import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchEmployerPublication, fetchGitHubJobList, pacePerHost, postingLinkKey, readJobPostingJsonLd } from "@internship-agent/agent";
import { extractDeterministically, normalizePostingText } from "@internship-agent/jobs";

// Synthetic fixtures for fictional employers; no candidate data and no network.
const fixture = (name: string) => readFileSync(new URL("./fixtures/posting-sources/" + name, import.meta.url), "utf8");
const json = (name: string, overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({ ...JSON.parse(fixture(name)) as object, ...overrides }));
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

const SPEEDY_SWE = "https://github.com/speedyapply/2027-SWE-College-Jobs";
const now = Date.parse("2026-11-19T12:00:00.000Z");
const fresh = { maxAgeDays: 3, season: null };
const row = (company: string, title: string, url: string, age = "0d", location = "USA") =>
  "| " + company + " | " + title + " | " + location + " | $40/hr | <a href=\"" + url + "\">Apply</a> | " + age + " |";
const isIndex = (url: string) => url.startsWith("https://raw.githubusercontent.com/");
const indexResponse = (url: string, readme: string) => new Response(url.endsWith("/README.md") ? readme : "");

const DOVER_ID = "3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f";
const DOVER_CLOSED_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const DOVER_API = "https://app.dover.io/api/v1/inbound/application-portal-job/";
const RIPPLING_ID = "8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const LEVER_EU_ID = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";

type Request = { url: string; init?: RequestInit };

async function run(readme: string, respond: (url: string, init?: RequestInit) => Response, options: Parameters<typeof fetchGitHubJobList>[2] = {}) {
  const requests: Request[] = [];
  const result = await fetchGitHubJobList({ url: SPEEDY_SWE }, async (url, init) => {
    if (isIndex(url)) return indexResponse(url, readme);
    requests.push({ url, init });
    return respond(url, init);
  }, { delayMs: 0, now, filter: fresh, ...options });
  return { ...result, requests, urls: requests.map((request) => request.url) };
}

const unexpected = (url: string): never => { throw new Error("Unexpected network request: " + url); };

describe("posting-page sources", () => {
  it("resolves Dover links through the public application-portal job endpoint", async () => {
    const readme = [
      row("Harbor Kite", "Software Engineering Intern", "https://app.dover.io/apply/job/" + DOVER_ID + "/?utm_source=Simplify&ref=Simplify"),
      row("Harbor Kite", "Closed Intern", "https://app.dover.io/apply/job/" + DOVER_CLOSED_ID + "/")
    ].join("\n");
    const result = await run(readme, (url) => {
      if (url === DOVER_API + DOVER_ID) return json("dover-job.json");
      if (url === DOVER_API + DOVER_CLOSED_ID) return json("dover-job.json", { id: DOVER_CLOSED_ID, active: false });
      return unexpected(url);
    });
    expect(result.urls).toEqual([DOVER_API + DOVER_ID, DOVER_API + DOVER_CLOSED_ID]);
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item).toMatchObject({ title: "Software Engineering Intern", companyName: "Harbor Kite", publication: null });
    expect(item.text.startsWith("Location: Mountain View, California, United States\n\n")).toBe(true);
    expect(item.text).toContain("\n- Python experience");
    expect(item.sourceUrl).toBe("https://app.dover.io/apply/job/" + DOVER_ID + "/");
    expect(postingLinkKey("https://app.dover.io/apply/job/" + DOVER_ID + "/?utm_source=Simplify&ref=Simplify")).toBe(postingLinkKey(item.sourceUrl!));
    expect(result.notes).toContain("Unavailable postings stay for manual review: closed, unlisted, or without a description 1.");
  });

  it("resolves classic iCIMS links from the job page's schema.org JobPosting", async () => {
    const listing = "https://careers-kestrel.icims.com/jobs/4242/software-engineer-intern/job?mobile=true&needsRedirect=false";
    const result = await run(row("Kestrel Analytics", "Software Engineer Intern", listing), (url) =>
      url === "https://careers-kestrel.icims.com/jobs/4242/job?in_iframe=1" ? html(fixture("icims-job.html")) : unexpected(url));
    expect(result.urls).toEqual(["https://careers-kestrel.icims.com/jobs/4242/job?in_iframe=1"]);
    expect(result.requests[0]!.init?.redirect).toBe("error");
    const item = result.items[0]!;
    expect(item).toMatchObject({ title: "Software Engineer Intern", companyName: "Kestrel Analytics" });
    expect(item.text.startsWith("Location: Chicago, IL, United States\n\n")).toBe(true);
    expect(item.text).toContain("\n- Python experience");
    expect(item.text).not.toContain("UNAVAILABLE");
    expect(item.sourceUrl).toBe("https://careers-kestrel.icims.com/jobs/4242/job");
    expect(item.publication).toMatchObject({ field: "datePosted", postedAt: "2026-11-18T05:00:00.000Z" });
    expect(postingLinkKey(listing)).toBe(postingLinkKey(item.sourceUrl!));
  });

  it("reads iCIMS Jibe career sites through the generic page source with the project user agent", async () => {
    const listing = "https://careers.larchsystems.example.com/jobs/9995?icims=1&lang=en-us&utm_source=Simplify";
    const target = "https://careers.larchsystems.example.com/jobs/9995?icims=1&lang=en-us";
    const result = await run(row("Larch Systems", "Systems Engineering Intern", listing), (url) =>
      url === target ? html(fixture("jibe-job.html")) : unexpected(url));
    expect(result.urls).toEqual([target]);
    const init = result.requests[0]!.init!;
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>)["user-agent"]).toBe("internship-agent-local");
    const item = result.items[0]!;
    expect(item.title).toBe("Systems Engineering Intern");
    expect(item.text.startsWith("Location: Denver, United States\n\n")).toBe(true);
    expect(item.text).toContain("Responsibilities:\n- Write and review test plans");
    expect(item.text).toContain("Qualifications:\n- Python experience");
    expect(item.text).not.toContain("UNAVAILABLE");
    expect(item.publication).toMatchObject({ field: "datePosted", postedAt: "2026-11-17T15:51:00.000Z" });
    expect(item.sourceUrl).toBe(target);
    expect(postingLinkKey(listing)).toBe(postingLinkKey(item.sourceUrl!));
  });

  it("follows same-host redirects on career pages and refuses other hosts and pages without JobPosting data", async () => {
    const readme = [
      row("Maple Works", "Machine Learning Intern", "https://www.mapleworks.example.com/jobs/123"),
      row("Maple Works", "Moved Intern", "https://www.mapleworks.example.com/jobs/456"),
      row("Maple Works", "Design Intern", "https://www.mapleworks.example.com/jobs/789")
    ].join("\n");
    const result = await run(readme, (url) => {
      if (url === "https://www.mapleworks.example.com/jobs/123") return new Response(null, { status: 301, headers: { location: "/profile/job_details/123/" } });
      if (url === "https://www.mapleworks.example.com/profile/job_details/123/") return html(fixture("career-page-job.html"));
      if (url === "https://www.mapleworks.example.com/jobs/456") return new Response(null, { status: 302, headers: { location: "https://other-host.example.com/x" } });
      if (url === "https://www.mapleworks.example.com/jobs/789") return html(fixture("career-page-no-json-ld.html"));
      return unexpected(url);
    });
    expect(result.urls).toEqual([
      "https://www.mapleworks.example.com/jobs/123",
      "https://www.mapleworks.example.com/profile/job_details/123/",
      "https://www.mapleworks.example.com/jobs/456",
      "https://www.mapleworks.example.com/jobs/789"
    ]);
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.title).toBe("Machine Learning Intern");
    expect(item.sourceUrl).toBe("https://www.mapleworks.example.com/jobs/123");
    expect(item.text.startsWith("Location: Menlo Park, CA, United States; Seattle, WA\n\n")).toBe(true);
    expect(item.text).toContain("\n- Python experience");
    const notes = result.notes.join(" ");
    expect(notes).toContain("redirected away from the posting's site 1");
    expect(notes).toContain("no schema.org JobPosting data 1");
    expect(notes).toContain("2 public postings were unavailable");
  });

  it("resolves Workable links through the public v2 job endpoint", async () => {
    const listing = "https://apply.workable.com/nimbus-labs/j/17F965FBBB/";
    const result = await run(row("Nimbus Labs", "Data Engineering Intern", listing), (url) =>
      url === "https://apply.workable.com/api/v2/accounts/nimbus-labs/jobs/17F965FBBB" ? json("workable-job.json") : unexpected(url));
    expect(result.urls).toEqual(["https://apply.workable.com/api/v2/accounts/nimbus-labs/jobs/17F965FBBB"]);
    const item = result.items[0]!;
    expect(item).toMatchObject({ title: "Data Engineering Intern", companyName: "Nimbus Labs" });
    expect(item.text.startsWith("Location: Austin, Texas, United States\n\n")).toBe(true);
    expect(item.text).toContain("Requirements:\n- ");
    expect(item.text).toContain("Benefits:\n");
    expect(item.sourceUrl).toBe(listing);
    expect(item.publication).toMatchObject({ field: "published", postedAt: "2026-11-18T14:30:00.000Z" });
    expect(postingLinkKey(listing)).toBe(postingLinkKey(item.sourceUrl!));
  });

  it("resolves Rippling links through the public board API without the company boilerplate", async () => {
    const listing = "https://ats.rippling.com/orchid/jobs/" + RIPPLING_ID;
    const endpoint = "https://api.rippling.com/platform/api/ats/v1/board/orchid/jobs/" + RIPPLING_ID;
    const result = await run(row("Orchid Robotics", "Hardware Test Intern", listing), (url) =>
      url === endpoint ? json("rippling-job.json") : unexpected(url));
    expect(result.urls).toEqual([endpoint]);
    const item = result.items[0]!;
    expect(item.title).toBe("Hardware Test Intern");
    expect(item.text.startsWith("Location: Ames, IA\n\n")).toBe(true);
    expect(item.text).toContain("\n- Python experience");
    expect(item.text).not.toContain("boilerplate");
    expect(item.publication).toBeNull();
    expect(item.sourceUrl).toBe(listing);
    expect(postingLinkKey(listing)).toBe(postingLinkKey(item.sourceUrl!));
  });

  it("resolves Greenhouse gh_jid employer links through the public board API, trying the company name then the domain", async () => {
    const board = (slug: string, id: string) => "https://boards-api.greenhouse.io/v1/boards/" + slug + "/jobs/" + id + "?content=true";
    const readme = [
      row("Pine Freight", "Logistics Software Intern", "https://careers.pinefreight.com/positions/8360478?gh_jid=8360478"),
      row("Quill Media", "Editorial Tools Intern", "https://quillhq.com/careers?gh_jid=999"),
      row("Nowhere Co", "Software Intern", "https://www.nowhereco.com/careers?gh_jid=777")
    ].join("\n");
    const result = await run(readme, (url) => {
      if (url === board("pinefreight", "8360478")) return json("greenhouse-embedded-job.json");
      if (url === board("quillmedia", "999")) return new Response("{}", { status: 404 });
      if (url === board("quillhq", "999")) return json("greenhouse-embedded-job.json", { id: 999, title: "Editorial Tools Intern", absolute_url: "https://quillhq.com/careers?gh_jid=999" });
      if (url === board("nowhereco", "777")) return new Response("{}", { status: 404 });
      return unexpected(url);
    });
    // Requests go to Greenhouse's board API only, never to the employer hosts.
    expect(result.urls).toEqual([board("pinefreight", "8360478"), board("quillmedia", "999"), board("quillhq", "999"), board("nowhereco", "777")]);
    expect(result.items.map((item) => item.title)).toEqual(["Logistics Software Intern", "Editorial Tools Intern"]);
    const item = result.items[0]!;
    expect(item.sourceUrl).toBe("https://careers.pinefreight.com/positions/8360478?gh_jid=8360478");
    expect(item.text.startsWith("Location: Omaha, NE\nOffice: Toronto, Ontario, Canada\n\n")).toBe(true);
    expect(item.publication).toMatchObject({ field: "first_published", postedAt: "2026-11-17T14:00:00.000Z" });
    expect(postingLinkKey(item.sourceUrl!)).toBe("greenhouse:8360478");
    expect(result.items[1]!.sourceUrl).toBe("https://quillhq.com/careers?gh_jid=999");
    expect(result.notes.join(" ")).toContain("no public Greenhouse board found for the company 1");
  });

  it("resolves Lever EU links through the EU postings API", async () => {
    const listing = "https://jobs.eu.lever.co/cirrusco/" + LEVER_EU_ID + "/apply";
    const endpoint = "https://api.eu.lever.co/v0/postings/cirrusco/" + LEVER_EU_ID;
    const result = await run(row("Cirrus Co", "Platform Engineering Intern", listing), (url) =>
      url === endpoint ? json("lever-eu-job.json") : unexpected(url));
    expect(result.urls).toEqual([endpoint]);
    const item = result.items[0]!;
    expect(item.title).toBe("Platform Engineering Intern");
    expect(item.text.startsWith("Location: Dublin, Ireland\n\n")).toBe(true);
    expect(item.text).toContain("Requirements:\n- Python experience");
    expect(item.sourceUrl).toBe("https://jobs.eu.lever.co/cirrusco/" + LEVER_EU_ID);
    expect(postingLinkKey(listing)).toBe(postingLinkKey(item.sourceUrl!));
  });

  it("reads the new sources' locations through the structured place reader", async () => {
    const board = "https://boards-api.greenhouse.io/v1/boards/pinefreight/jobs/8360478?content=true";
    const sources: Array<{ listing: string; respond: (url: string) => Response | undefined; country: string }> = [
      { listing: "https://app.dover.io/apply/job/" + DOVER_ID + "/", respond: (url) => url === DOVER_API + DOVER_ID ? json("dover-job.json") : undefined, country: "US" },
      { listing: "https://careers-kestrel.icims.com/jobs/4242/software-engineer-intern/job",
        respond: (url) => url === "https://careers-kestrel.icims.com/jobs/4242/job?in_iframe=1" ? html(fixture("icims-job.html")) : undefined, country: "US" },
      { listing: "https://careers.larchsystems.example.com/jobs/9995?icims=1&lang=en-us",
        respond: (url) => url === "https://careers.larchsystems.example.com/jobs/9995?icims=1&lang=en-us" ? html(fixture("jibe-job.html")) : undefined, country: "US" },
      { listing: "https://www.mapleworks.example.com/profile/job_details/123/",
        respond: (url) => url === "https://www.mapleworks.example.com/profile/job_details/123/" ? html(fixture("career-page-job.html")) : undefined, country: "US" },
      { listing: "https://apply.workable.com/nimbus-labs/j/17F965FBBB/",
        respond: (url) => url === "https://apply.workable.com/api/v2/accounts/nimbus-labs/jobs/17F965FBBB" ? json("workable-job.json") : undefined, country: "US" },
      { listing: "https://ats.rippling.com/orchid/jobs/" + RIPPLING_ID,
        respond: (url) => url === "https://api.rippling.com/platform/api/ats/v1/board/orchid/jobs/" + RIPPLING_ID ? json("rippling-job.json") : undefined, country: "US" },
      { listing: "https://careers.pinefreight.com/positions/8360478?gh_jid=8360478", respond: (url) => url === board ? json("greenhouse-embedded-job.json") : undefined, country: "US" },
      { listing: "https://jobs.eu.lever.co/cirrusco/" + LEVER_EU_ID,
        respond: (url) => url === "https://api.eu.lever.co/v0/postings/cirrusco/" + LEVER_EU_ID ? json("lever-eu-job.json") : undefined, country: "IE" }
    ];
    for (const source of sources) {
      const result = await run(row("Pine Freight", "Software Intern", source.listing), (url) => source.respond(url) ?? unexpected(url));
      expect(result.items, source.listing).toHaveLength(1);
      const text = result.items[0]!.text;
      expect(text, source.listing).not.toContain("Job list location");
      const countries = extractDeterministically(normalizePostingText(text)).locations.map((location) => location.countryCode);
      expect(countries, source.listing).toContain(source.country);
    }
  });

  it("names a JSON-LD country code in full so it is never read as a US state", async () => {
    const page = "<script type=\"application/ld+json\">" + JSON.stringify({
      "@type": "JobPosting", title: "Research Intern", description: "<p>Study things carefully and report findings to the team.</p>",
      jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Berlin", addressCountry: "DE" } }
    }) + "</script>";
    const read = readJobPostingJsonLd(page);
    expect(read?.location).toBe("Berlin, Germany");
    const countries = extractDeterministically(normalizePostingText("Location: " + read!.location + "\n\n" + read!.body)).locations.map((location) => location.countryCode);
    expect(countries).toContain("DE");
    expect(countries).not.toContain("US");
  });

  it("names a Workable country code when the place gives no country name", async () => {
    const place = { country: null, countryCode: "SG", city: "Singapore", region: null };
    const result = await run(row("Nimbus Labs", "Data Engineering Intern", "https://apply.workable.com/nimbus-labs/j/17F965FBBB/"), (url) =>
      url === "https://apply.workable.com/api/v2/accounts/nimbus-labs/jobs/17F965FBBB"
        ? json("workable-job.json", { location: place, locations: [{ ...place, hidden: false }] }) : unexpected(url));
    const text = result.items[0]!.text;
    expect(text.startsWith("Location: Singapore\n\n")).toBe(true);
    expect(extractDeterministically(normalizePostingText(text)).locations.map((location) => location.countryCode)).toContain("SG");
  });

  it("labels the list's location column only when a Dover posting names no readable place", async () => {
    const listing = "https://app.dover.io/apply/job/" + DOVER_ID + "/";
    const remote = await run(row("Harbor Kite", "Software Engineering Intern", listing, "0d", "Austin, TX"), (url) =>
      url === DOVER_API + DOVER_ID ? json("dover-job.json", { locations: [], location: null, workplace_type: "REMOTE" }) : unexpected(url));
    expect(remote.items[0]!.text.startsWith("Job list location: Austin, TX\n\nLocation: Remote\n\n")).toBe(true);
    const placed = await run(row("Harbor Kite", "Software Engineering Intern", listing, "0d", "Austin, TX"), (url) =>
      url === DOVER_API + DOVER_ID ? json("dover-job.json") : unexpected(url));
    expect(placed.items[0]!.text).not.toContain("Job list location");
    expect(placed.items[0]!.text.startsWith("Location: Mountain View, California, United States\n\n")).toBe(true);
  });

  it("never fetches a row older than the age limit, whatever its source", async () => {
    const links = [
      "https://app.dover.io/apply/job/" + DOVER_ID + "/",
      "https://careers-kestrel.icims.com/jobs/4242/software-engineer-intern/job",
      "https://apply.workable.com/nimbus-labs/j/17F965FBBB/",
      "https://ats.rippling.com/orchid/jobs/" + RIPPLING_ID,
      "https://careers.pinefreight.com/positions/8360478?gh_jid=8360478",
      "https://jobs.eu.lever.co/cirrusco/" + LEVER_EU_ID,
      "https://careers.larchsystems.example.com/jobs/9995?icims=1&lang=en-us",
      "https://jobs.apple.com/en-us/details/200600001/software-engineering-intern"
    ];
    const readme = links.map((link, n) =>
      "<tr><td>Old Co " + n + "</td><td>Software Intern</td><td>Remote</td><td><a href=\"" + link + "\">Apply</a></td><td>4d</td></tr>").join("\n");
    const postingRequests: string[] = [];
    const result = await fetchGitHubJobList({ url: "https://github.com/SimplifyJobs/Summer2027-Internships" }, async (url) => {
      if (url.startsWith("https://raw.githubusercontent.com/")) return new Response(readme);
      postingRequests.push(url);
      throw new Error("A row past the age limit was fetched: " + url);
    }, { delayMs: 0, now, filter: fresh });
    expect(postingRequests).toEqual([]);
    expect(result.items).toEqual([]);
    expect(result.notes).toContain("8 listed rows were older than 3 days or undated and skipped.");

    const seconds = (daysAgo: number) => Math.floor((now - daysAgo * 86_400_000) / 1000);
    const vansh = JSON.stringify([{ company_name: "Old Co", title: "Software Intern", url: "https://go.vansh.nyc/OLD1", active: true, date_posted: seconds(4), season: "Summer" }]);
    const shortLinkRequests: string[] = [];
    const fromVansh = await fetchGitHubJobList({ url: "https://github.com/vanshb03/Summer2027-Internships" }, async (url) => {
      if (url.startsWith("https://raw.githubusercontent.com/")) return new Response(vansh);
      shortLinkRequests.push(url);
      throw new Error("A row past the age limit was fetched: " + url);
    }, { delayMs: 0, now, filter: fresh });
    expect(shortLinkRequests).toEqual([]);
    expect(fromVansh.notes).toContain("1 listed row was older than 3 days or undated and skipped.");
  });

  it("keeps unsupported hosts for manual review without fetching them", async () => {
    const readme = [
      row("Link Co", "Software Intern", "https://www.linkedin.com/jobs/view/1"),
      row("Amazon Example", "Software Intern", "https://www.amazon.example.com/jobs/10608081/apply"),
      row("Test Co", "Software Intern", "https://example.test/jobs/1"),
      row("Internal Co", "Software Intern", "https://10.0.0.5/jobs/1"),
      row("Only Co", "Software Intern", "https://jobs.smartrecruiters.com/OnlyCompany"),
      row("Harbor Kite", "Software Engineering Intern", "https://app.dover.io/apply/job/" + DOVER_ID + "/")
    ].join("\n");
    const result = await run(readme, (url) => url === DOVER_API + DOVER_ID ? json("dover-job.json") : unexpected(url));
    expect(result.urls).toEqual([DOVER_API + DOVER_ID]);
    expect(result.items).toHaveLength(1);
    const notes = result.notes.join(" ");
    expect(notes).toContain("5 links need manual review");
    expect(notes).toContain("Manual review, no supported full-posting source:");
    expect(notes).toContain("www.linkedin.com 1");
    expect(notes).toContain("10.0.0.5 1");
    expect(notes).toContain("jobs.smartrecruiters.com 1");
  });

  it("spaces requests to the same host with the shared per-host pacer", async () => {
    const DOVER_B = "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e";
    const readme = [
      row("Harbor Kite", "Software Engineering Intern", "https://app.dover.io/apply/job/" + DOVER_ID + "/"),
      row("Nimbus Labs", "Data Engineering Intern", "https://apply.workable.com/nimbus-labs/j/17F965FBBB/"),
      row("Harbor Kite", "Data Intern", "https://app.dover.io/apply/job/" + DOVER_B + "/")
    ].join("\n");
    const respond = (url: string) => {
      if (url === DOVER_API + DOVER_ID) return json("dover-job.json");
      if (url === DOVER_API + DOVER_B) return json("dover-job.json", { id: DOVER_B, title: "Data Intern" });
      if (url === "https://apply.workable.com/api/v2/accounts/nimbus-labs/jobs/17F965FBBB") return json("workable-job.json");
      return unexpected(url);
    };
    const events: string[] = [];
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); events.push("sleep"); };
    const paced = await fetchGitHubJobList({ url: SPEEDY_SWE }, async (url) => {
      if (isIndex(url)) return indexResponse(url, readme);
      events.push(url);
      return respond(url);
    }, { delayMs: 0, hostIntervalMs: 500, sleep, now, filter: fresh });
    expect(paced.items).toHaveLength(3);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(400);
    expect(waits[0]).toBeLessThanOrEqual(500);
    expect(events.indexOf("sleep")).toBe(events.indexOf(DOVER_API + DOVER_B) - 1);

    // Production defaults: 350 ms between posting requests plus the per-host interval.
    const defaultWaits: number[] = [];
    const production = await fetchGitHubJobList({ url: SPEEDY_SWE }, async (url) => isIndex(url) ? indexResponse(url, readme) : respond(url),
      { sleep: async (ms) => { defaultWaits.push(ms); }, now, filter: fresh });
    expect(production.items).toHaveLength(3);
    expect(defaultWaits.filter((ms) => ms === 350)).toHaveLength(2);
    const hostWaits = defaultWaits.filter((ms) => ms !== 350);
    expect(hostWaits).toHaveLength(1);
    expect(hostWaits[0]).toBeGreaterThan(0);
    expect(hostWaits[0]).toBeLessThanOrEqual(500);
  });

  it("paces each host on its own clock", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const calls: string[] = [];
    const fetcher = pacePerHost(async (url) => { calls.push(url + "@" + clock); return new Response("ok"); }, 500, {
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; }
    });
    for (const url of ["https://a.example.test/1", "https://a.example.test/2", "https://b.example.test/1", "https://a.example.test/3"]) await fetcher(url);
    expect(sleeps).toEqual([500, 500]);
    expect(calls).toEqual(["https://a.example.test/1@0", "https://a.example.test/2@500", "https://b.example.test/1@500", "https://a.example.test/3@1000"]);
  });
});

describe("schema.org JobPosting reader", () => {
  const posting = (fields: Record<string, unknown> = {}) => ({
    "@type": "JobPosting", title: "Research Intern", description: "<p>Study things carefully and report findings to the team.</p>", ...fields
  });
  const page = (...blocks: string[]) => blocks.map((block) => "<script type=\"application/ld+json\">" + block + "</script>").join("\n");

  it("finds a JobPosting inside @graph", () => {
    const read = readJobPostingJsonLd(page(JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "WebPage" }, posting()] })));
    expect(read).toMatchObject({ title: "Research Intern", location: null, datePosted: null, expired: false });
  });

  it("refuses pages with two different JobPostings", () => {
    expect(readJobPostingJsonLd(page(JSON.stringify(posting()), JSON.stringify(posting({ title: "Other Intern" }))))).toBeNull();
    expect(readJobPostingJsonLd(page(JSON.stringify(posting()), JSON.stringify(posting())))).not.toBeNull();
  });

  it("skips a malformed block and reads a later valid one", () => {
    expect(readJobPostingJsonLd(page("{ not json", JSON.stringify(posting())))?.title).toBe("Research Intern");
  });

  it("marks a past validThrough as expired and normalizes a +0000 offset", () => {
    const read = readJobPostingJsonLd(page(JSON.stringify(posting({ validThrough: "2020-01-01T00:00:00Z", datePosted: "2026-11-17T15:51:00+0000", jobLocationType: "TELECOMMUTE" }))), now);
    expect(read).toMatchObject({ expired: true, datePosted: "2026-11-17T15:51:00+00:00", location: "Remote" });
  });

  it("returns null when only an Organization is described", () => {
    expect(readJobPostingJsonLd(page(JSON.stringify({ "@type": "Organization", name: "Larch Systems" })))).toBeNull();
    expect(readJobPostingJsonLd("<html><body>No structured data</body></html>")).toBeNull();
  });
});

describe("posting identities for the new sources", () => {
  it("gives a listing link and its stored posting URL the same key", () => {
    const pairs: Array<[string, string]> = [
      ["https://app.dover.io/apply/job/" + DOVER_ID.toUpperCase() + "/?utm_source=Simplify", "https://app.dover.io/apply/job/" + DOVER_ID + "/"],
      ["https://careers-kestrel.icims.com/jobs/4242/software-engineer-intern/job?mobile=true", "https://careers-kestrel.icims.com/jobs/4242/job"],
      ["https://apply.workable.com/nimbus-labs/j/17f965fbbb/apply", "https://apply.workable.com/nimbus-labs/j/17F965FBBB/"],
      ["https://ats.rippling.com/orchid/jobs/" + RIPPLING_ID.toUpperCase() + "?utm_source=Simplify", "https://ats.rippling.com/orchid/jobs/" + RIPPLING_ID],
      ["https://jobs.eu.lever.co/cirrusco/" + LEVER_EU_ID + "/apply", "https://jobs.eu.lever.co/cirrusco/" + LEVER_EU_ID],
      ["https://careers.pinefreight.com/positions/8360478?gh_jid=8360478&utm_source=Simplify", "https://job-boards.greenhouse.io/pinefreight/jobs/8360478"],
      ["https://careers.larchsystems.example.com/jobs/9995?lang=en-us&icims=1&utm_source=Simplify&ref=Simplify#top", "https://careers.larchsystems.example.com/jobs/9995/?icims=1&lang=en-us"]
    ];
    for (const [listing, stored] of pairs) {
      expect(postingLinkKey(listing)).not.toBeNull();
      expect(postingLinkKey(listing)).toBe(postingLinkKey(stored));
    }
    expect(postingLinkKey("https://careers.larchsystems.example.com/jobs/9995?icims=1&lang=en-us"))
      .not.toBe(postingLinkKey("https://careers.larchsystems.example.com/jobs/9995?icims=1&lang=fr-fr"));
    expect(postingLinkKey("https://example.test/apply/1")).toBeNull();
  });

  it("reads no employer publication for Dover or career-page URLs", async () => {
    let requested = false;
    const fetcher = async () => { requested = true; return new Response("{}"); };
    expect(await fetchEmployerPublication("https://app.dover.io/apply/job/" + DOVER_ID + "/", fetcher)).toBeNull();
    expect(await fetchEmployerPublication("https://careers.larchsystems.example.com/jobs/9995?icims=1", fetcher)).toBeNull();
    expect(requested).toBe(false);
  });
});
