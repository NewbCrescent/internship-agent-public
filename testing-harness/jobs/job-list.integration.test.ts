import { competitivenessFixture } from "../matching/competitiveness-fixture";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { getPipelineCounts, getReviewQueuePage, getReviewQueueWithResumeState, evaluateAndPersistMatch, saveReviewFocusSettings } from "@internship-agent/agent";
import { DEFAULT_REVIEW_FOCUS } from "@internship-agent/domain";
import { saveSemanticFit, getFitInputVersion, saveJobMatch, saveDiscoverySkip, createDatabase, getJobListFingerprint, listFitScores, persistNormalizedPosting, seedDevelopmentData, savePostingPublication, getJobPosting, getJobMatch } from "@internship-agent/db";
import { getDashboardJobsPage, getJobListPage, JOBS_PER_PAGE } from "@internship-agent/jobs";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function workspace(extraPostings: number): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-job-list-"));
  directories.push(directory);
  const database = createDatabase(join(directory, "test.sqlite"));
  seedDevelopmentData(database);
  for (let index = 0; index < extraPostings; index += 1) addPosting(database, `Fixture Page Intern ${index}`);
  return database;
}

function addPosting(database: DatabaseSync, title: string): string {
  return persistNormalizedPosting(database, {
    companyName: "Fixture Company", title, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
    sourceUrl: `https://example.test/job-list/${encodeURIComponent(title)}`, externalApplicationUrl: null, companyCareersUrl: null,
    contentHash: `hash-${title}`, normalizedText: `${title}\nFixture posting for Jobs pagination.`,
    locations: [], compensation: null, requirements: [], technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  }).jobId;
}

describe("paged Jobs list", () => {
  it("serves 50 postings per page and clamps out-of-range pages", () => {
    const database = workspace(60);
    const first = getJobListPage(database, { sort: "newest", category: null, page: 1 });
    expect(first.total).toBe(61);
    expect(first.ids).toHaveLength(JOBS_PER_PAGE);
    expect(first.pageCount).toBe(2);
    const second = getJobListPage(database, { sort: "newest", category: null, page: 2 });
    expect(second.ids).toHaveLength(11);
    expect(new Set([...first.ids, ...second.ids]).size).toBe(61);
    expect(getJobListPage(database, { sort: "newest", category: null, page: 99 })).toMatchObject({ page: 2, ids: second.ids });
    database.close();
  });

  it("reuses the sorted order until a posting is added or analyzed again", () => {
    const database = workspace(3);
    const options = { sort: "fit" as const, category: null, page: 1 };
    expect(getJobListPage(database, options).cached).toBe(false);
    expect(getJobListPage(database, options).cached).toBe(true);
    // Another sort is its own cache entry.
    expect(getJobListPage(database, { ...options, sort: "newest" }).cached).toBe(false);

    const before = getJobListFingerprint(database);
    const added = addPosting(database, "Fixture Late Intern");
    expect(getJobListFingerprint(database)).not.toBe(before);
    const afterAdd = getJobListPage(database, options);
    expect(afterAdd.cached).toBe(false);
    expect(afterAdd.total).toBe(5);
    expect(getJobListPage(database, options).cached).toBe(true);

    // Re-analysis changes fit, so the cached fit order must not survive it.
    evaluateAndPersistMatch(added, { database });
    const afterAnalysis = getJobListPage(database, options);
    expect(afterAnalysis.cached).toBe(false);
    expect(afterAnalysis.ids[0]).toBe(added);
    database.close();
  });

  it("sorts cached AI scores first without requiring a deterministic match", () => {
    const database = workspace(0);
    try {
      const scored = addPosting(database, "Fixture AI Scored");
      saveSemanticFit(database, scored, getFitInputVersion(database, scored), competitivenessFixture(88));
      const plain = addPosting(database, "Fixture Unscored");
      expect(listFitScores(database).get(scored)).toBe(88);
      expect(listFitScores(database).has(plain)).toBe(false);
      expect(getJobListPage(database, { sort: "fit", category: null, page: 1 }).ids[0]).toBe(scored);
    } finally { database.close(); }
  });
});

describe("publication-date storage and cache", () => {
  it("filters before pagination and expires without a database change", () => {
    const database = workspace(0);
    const id = addPosting(database, "Fresh Software Intern");
    const now = Date.parse("2026-10-06T12:00:00Z");
    savePostingPublication(database, id, { postedAt: "2026-10-03T12:00:00Z", sourceUrl: "https://example.test/job", field: "first_published", precision: "timestamp" });
    const options = { sort: "newest" as const, category: null, page: 99, postedWithinDays: 3 };
    expect(getJobListPage(database, options, now)).toMatchObject({ ids: [id], filtered: 1, unknownDates: 1, page: 1 });
    expect(getJobListPage(database, options, now).cached).toBe(true);
    expect(getJobListPage(database, options, now + 1)).toMatchObject({ ids: [], filtered: 0, cached: false });
    expect(getJobListPage(database, { ...options, postedWithinDays: null }, now).ids).toHaveLength(2);
    database.close();
  });
  it("a metadata backfill refreshes cached lists without rewriting application state, snapshots, or matches", () => {
    const database = workspace(0);
    const id = addPosting(database, "Metadata Software Intern");
    evaluateAndPersistMatch(id, { database });
    const before = getJobPosting(database, id)!;
    const match = getJobMatch(database, id);
    const options = { sort: "fit" as const, category: null, page: 1, postedWithinDays: 3 };
    const now = Date.now();
    expect(getJobListPage(database, options, now).filtered).toBe(0);
    savePostingPublication(database, id, { postedAt: new Date(now - 1000).toISOString(), sourceUrl: before.source.sourceUrl, field: "publishedAt", precision: "timestamp" });
    expect(getJobListPage(database, options, now)).toMatchObject({ ids: [id], cached: false });
    const after = getJobPosting(database, id)!;
    expect(after.snapshot).toEqual(before.snapshot);
    expect(after.status).toBe(before.status);
    expect(getJobMatch(database, id)).toEqual(match);
    database.close();
  });
});


describe("bounded dashboard reads", () => {
  it("keeps counts global while paging status-filtered applications and review entries", () => {
    const database = workspace(2000);
    try {
      database.prepare("UPDATE jobs SET status = 'READY_FOR_REVIEW' WHERE title LIKE 'Fixture Page%'").run();
      const first = getDashboardJobsPage(database, { status: "READY_FOR_REVIEW" });
      const second = getDashboardJobsPage(database, { status: "READY_FOR_REVIEW", page: "2" });
      expect(first).toMatchObject({ total: 2000, page: 1, pageCount: 40 });
      expect(first.jobs).toHaveLength(50);
      expect(second.jobs).toHaveLength(50);
      expect(new Set([...first.jobs, ...second.jobs].map((job) => job.id)).size).toBe(100);
      expect(getDashboardJobsPage(database, { page: "bad", status: "bad" })).toMatchObject({ total: 2001, page: 1, status: undefined });
      expect(getDashboardJobsPage(database, {}, 20).jobs).toHaveLength(20);
      expect(getPipelineCounts(database).READY_FOR_REVIEW).toBe(2000);
      const review = getReviewQueuePage(database, { view: "all", page: "999" });
      expect(review).toMatchObject({ total: 2000, page: 40, pageCount: 40 });
      expect(review.queue).toHaveLength(50);
      expect(review.queue.every((entry) => entry.resumeChanged === false)).toBe(true);
      // Refresh all continues to resolve the entire queue, independent of the visible page.
      expect(getReviewQueueWithResumeState(database)).toHaveLength(2000);
      expect(getReviewQueuePage(database, { view: "all", page: "2" }).queue.map((entry) => entry.jobId))
        .not.toEqual(getReviewQueuePage(database, { view: "all", page: "1" }).queue.map((entry) => entry.jobId));
      database.prepare("UPDATE jobs SET status = 'APPROVED' WHERE status = 'READY_FOR_REVIEW'").run();
      expect(getReviewQueuePage(database, { view: "all", page: "99" })).toMatchObject({ total: 0, page: 1, pageCount: 1, queue: [] });
    } finally { database.close(); }
  });
});


describe("Review Queue fit sorting and employer age", () => {
  it("filters inclusive date boundaries, rejects future and unknown dates, and expires without writes", () => {
    const database = workspace(0);
    const now = Date.parse("2026-10-07T12:00:00Z");
    const cutoff = now - 3 * 86_400_000;
    const add = (name: string, score: number | null, published: number | null) => {
      const id = addPosting(database, `Review Age ${name}`);
      if (score !== null) {
        const { report } = evaluateAndPersistMatch(id, { database });
        saveJobMatch(database, { ...report, fitScore: score });
        saveSemanticFit(database, id, getFitInputVersion(database, id), competitivenessFixture(score));
      }
      database.prepare("UPDATE jobs SET status = 'READY_FOR_REVIEW' WHERE id = ?").run(id);
      if (published !== null) savePostingPublication(database, id, {
        postedAt: new Date(published).toISOString(), sourceUrl: "https://example.test/employer",
        field: "publishedAt", precision: "timestamp"
      });
      return id;
    };
    try {
      const boundary = add("boundary", 95, cutoff);
      const fresh = add("fresh", 70, now);
      const unscored = add("unscored", null, now - 1000);
      add("old", 99, cutoff - 1);
      const future = add("future", 100, now + 1);
      add("unknown", 100, null);
      const skipped = add("skipped", 100, now);
      saveDiscoverySkip(database, { jobId: skipped, reason: "Synthetic skip", preferenceNote: null });
      const filtered = getReviewQueuePage(database, { view: "all", days: "3", sort: "fit", page: "99" }, now);
      expect(filtered).toMatchObject({ total: 3, queueTotal: 6, unknownDates: 1, page: 1, postedWithinDays: 3 });
      expect(filtered.queue.map((entry) => entry.jobId)).toEqual([boundary, fresh, unscored]);
      expect(filtered.queue[0]).toMatchObject({ fitScore: 95, postedAt: new Date(cutoff).toISOString() });
      expect(getReviewQueuePage(database, { view: "all", days: "3" }, now + 1).queue.map((entry) => entry.jobId))
        .toEqual([future, fresh, unscored]);
      expect(getReviewQueuePage(database, { view: "all", days: "3" }, now + 1).queue.some((entry) => entry.jobId === boundary)).toBe(false);
      expect(getReviewQueuePage(database, { view: "all", days: "invalid", sort: "invalid", page: "bad" }, now))
        .toMatchObject({ total: 6, sort: "fit", postedWithinDays: null, page: 1 });
      expect(getReviewQueueWithResumeState(database)).toHaveLength(6);
      expect(getReviewQueuePage(database, { view: "all", days: "1" }, now + 10 * 86_400_000))
        .toMatchObject({ total: 0, queueTotal: 6, queue: [] });
    } finally { database.close(); }
  });

  it("sorts by fit before slicing pages and uses newest imports as a tie-breaker", () => {
    const database = workspace(0);
    try {
      const ids: string[] = [];
      for (let index = 0; index < 61; index += 1) {
        const id = addPosting(database, `Review Sorted ${index}`);
        ids.push(id);
        const { report } = evaluateAndPersistMatch(id, { database });
        saveJobMatch(database, { ...report, fitScore: index });
        saveSemanticFit(database, id, getFitInputVersion(database, id), competitivenessFixture(index));
        database.prepare("UPDATE jobs SET status = 'READY_FOR_REVIEW', created_at = ? WHERE id = ?")
          .run(new Date(Date.parse("2026-10-07T12:00:00Z") - index * 1000).toISOString(), id);
      }
      const first = getReviewQueuePage(database, { view: "all", sort: "fit" });
      const second = getReviewQueuePage(database, { view: "all", sort: "fit", page: 2 });
      expect(first).toMatchObject({ total: 61, pageCount: 2 });
      expect(first.queue.map((entry) => entry.fitScore)).toEqual(Array.from({ length: 50 }, (_, i) => 60 - i));
      expect(second.queue.map((entry) => entry.fitScore)).toEqual(Array.from({ length: 11 }, (_, i) => 10 - i));
      expect(getReviewQueuePage(database, { view: "all", sort: "newest" }).queue[0].jobId).toBe(ids[0]);
      saveSemanticFit(database, ids[0], getFitInputVersion(database,ids[0]), competitivenessFixture(60));
      expect(getReviewQueuePage(database, { view: "all" }).queue[0].jobId).toBe(ids[0]);
      expect(getReviewQueuePage(database, { view: "all" }).queue[1].jobId).toBe(ids[60]);
    } finally { database.close(); }
  });
});

type Place = { raw: string; countryCode: string | null };
type Pay = { minimum: number | null; maximum: number | null; currency: string; period: "HOUR" | "MONTH" | "YEAR" | "STIPEND" };

// Spans quote the posting text, so each fixture states its place and pay verbatim.
function addFiltered(database: DatabaseSync, title: string, places: Place[], pay: (Pay & { raw: string }) | null): string {
  const normalizedText = [title, ...places.map((place) => place.raw), pay?.raw ?? "Pay not stated."].join("\n");
  const at = (raw: string) => {
    const start = normalizedText.indexOf(raw);
    return { start, end: start + raw.length, excerpt: raw };
  };
  const id = persistNormalizedPosting(database, {
    companyName: "Filter Fixture", title, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
    sourceUrl: `https://example.test/filters/${encodeURIComponent(title)}`, externalApplicationUrl: null, companyCareersUrl: null,
    contentHash: `filters-${title}`, normalizedText,
    locations: places.map((place) => ({ raw: place.raw, city: null, region: null, countryCode: place.countryCode, workMode: "UNSPECIFIED" as const, span: at(place.raw) })),
    compensation: pay ? { ...pay, span: at(pay.raw) } : null,
    requirements: [], technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  }).jobId;
  database.prepare("UPDATE jobs SET status = 'READY_FOR_REVIEW' WHERE id = ?").run(id);
  return id;
}

describe("country and pay filters", () => {
  function filteredWorkspace() {
    const database = workspace(0);
    const ids = {
      usHourly: addFiltered(database, "US Hourly Intern", [{ raw: "Austin, TX", countryCode: "US" }], { raw: "$45/hour", minimum: 40, maximum: 45, currency: "USD", period: "HOUR" }),
      // $104,000 a year is $50 an hour at 2,080 hours.
      usYearly: addFiltered(database, "US Yearly Intern", [{ raw: "Boston, MA", countryCode: "US" }], { raw: "$104,000 per year", minimum: 104_000, maximum: null, currency: "USD", period: "YEAR" }),
      singapore: addFiltered(database, "Singapore Intern", [{ raw: "Singapore", countryCode: "SG" }], null),
      canadaCad: addFiltered(database, "Canada Intern", [{ raw: "Toronto, ON", countryCode: "CA" }], { raw: "CAD $9,000 per month", minimum: 9_000, maximum: null, currency: "CAD", period: "MONTH" }),
      bothCountries: addFiltered(database, "Two Country Intern", [{ raw: "Seattle, WA", countryCode: "US" }, { raw: "Vancouver, BC", countryCode: "CA" }], { raw: "$9,000 per month", minimum: 9_000, maximum: null, currency: "USD", period: "MONTH" }),
      remote: addFiltered(database, "Remote Intern", [{ raw: "Remote", countryCode: null }], { raw: "a competitive stipend", minimum: null, maximum: null, currency: "USD", period: "STIPEND" })
    };
    return { database, ids };
  }

  it("filters the Review Queue by country and USD pay in SQL before counting and paging", () => {
    const { database, ids } = filteredWorkspace();
    try {
      const jobIds = (query: Parameters<typeof getReviewQueuePage>[1]) => getReviewQueuePage(database, { view: "all", ...query }).queue.map((entry) => entry.jobId).sort();
      expect(jobIds({ country: "SG" })).toEqual([ids.singapore]);
      expect(jobIds({ country: "ca" })).toEqual([ids.bothCountries, ids.canadaCad].sort());
      expect(jobIds({ country: "none" })).toEqual([ids.remote]);
      // Hourly compares the top of the range; monthly and yearly convert at 2,080 hours; CAD and stipends never pass.
      expect(jobIds({ minPay: "45" })).toEqual([ids.usHourly, ids.usYearly, ids.bothCountries].sort());
      expect(jobIds({ minPay: "50" })).toEqual([ids.usYearly, ids.bothCountries].sort());
      expect(jobIds({ country: "US", minPay: "51" })).toEqual([ids.bothCountries]);

      const page = getReviewQueuePage(database, { view: "all", country: "SG", minPay: "40" });
      expect(page).toMatchObject({ total: 0, country: "SG", minHourlyPay: 40, unstated: { country: 1, pay: 1 } });
      expect(getReviewQueuePage(database, { view: "all", minPay: "40" }).unstated).toEqual({ country: 0, pay: 3 });
      expect(getReviewQueuePage(database, { view: "all" }).countries).toEqual({
        countries: [{ code: "US", count: 3 }, { code: "CA", count: 2 }, { code: "SG", count: 1 }], unstated: 1
      });
      // Malformed values are ignored rather than emptying the queue.
      expect(getReviewQueuePage(database, { view: "all", country: "USA", minPay: "-5" })).toMatchObject({ total: 6, country: null, minHourlyPay: null });
    } finally { database.close(); }
  });

  it("filters the Jobs list the same way and caches each filter combination separately", () => {
    const { database, ids } = filteredWorkspace();
    try {
      const options = { sort: "newest" as const, category: null, page: 1 };
      // Unlike the Review Queue, Jobs also lists the seeded posting: Seattle, WA at $45–$60 an hour.
      const seeded = (database.prepare("SELECT id FROM jobs WHERE company_name != 'Filter Fixture'").all() as Array<{ id: string }>).map((row) => row.id);
      expect(seeded).toHaveLength(1);
      expect(getJobListPage(database, { ...options, country: "SG" }).ids).toEqual([ids.singapore]);
      expect(getJobListPage(database, { ...options, minHourlyPay: 50 }).ids.sort()).toEqual([ids.usYearly, ids.bothCountries, seeded[0]].sort());
      // $9,000 a month is about $51.92 an hour; the CAD posting is hidden as having no USD pay.
      const filtered = getJobListPage(database, { ...options, country: "CA", minHourlyPay: 51 });
      expect(filtered).toMatchObject({ ids: [ids.bothCountries], filtered: 1, unstated: { country: 1, pay: 1 } });
      expect(getJobListPage(database, { ...options, country: "US", minHourlyPay: 56 }).ids).toEqual([seeded[0]]);
      expect(getJobListPage(database, { ...options, country: "DE" }).unstated.country).toBe(1);
      expect(getJobListPage(database, options).countries).toEqual({
        countries: [{ code: "US", count: 4 }, { code: "CA", count: 2 }, { code: "SG", count: 1 }], unstated: 1
      });
    } finally { database.close(); }
  });
});

describe("the Review Queue focus view", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

  function focusWorkspace() {
    const database = workspace(0);
    const posted = (id: string, days: number) => savePostingPublication(database, id, {
      postedAt: daysAgo(days), sourceUrl: "https://example.test/employer", field: "first_published", precision: "timestamp"
    });
    const scored = (id: string, score: number) => saveSemanticFit(database, id, getFitInputVersion(database, id), competitivenessFixture(score));
    const us = [{ raw: "Austin, TX", countryCode: "US" }];
    const hourly = (amount: number) => ({ raw: `$${amount}/hour`, minimum: amount, maximum: null, currency: "USD", period: "HOUR" as const });
    const ids = {
      topFit: addFiltered(database, "Software Engineering Intern A", us, hourly(30)),
      tieRich: addFiltered(database, "Machine Learning Intern B", us, hourly(60)),
      tiePoor: addFiltered(database, "Cloud Platform Intern C", [], hourly(35)),
      unscored: addFiltered(database, "Backend Developer Intern D", us, null),
      quant: addFiltered(database, "Quantitative Trading Intern E", us, hourly(90)),
      abroad: addFiltered(database, "Software Engineer Intern F", [{ raw: "Singapore", countryCode: "SG" }], null),
      stale: addFiltered(database, "Software Engineer Intern G", us, null)
    };
    scored(ids.topFit, 92); scored(ids.tieRich, 80); scored(ids.tiePoor, 80); scored(ids.quant, 99); scored(ids.abroad, 95); scored(ids.stale, 97);
    posted(ids.topFit, 2); posted(ids.tieRich, 5); posted(ids.stale, 20);
    database.prepare("UPDATE jobs SET external_application_url = ? WHERE id = ?").run("https://jobs.lever.co/acme/123", ids.topFit);
    return { database, ids };
  }

  it("shows focused postings ranked by AI fit, then pay, by default", () => {
    const { database, ids } = focusWorkspace();
    try {
      const page = getReviewQueuePage(database, {}, now);
      expect(page).toMatchObject({ view: "focus", focusTotal: 4, queueTotal: 7, total: 4 });
      // Quant is outside the focus categories, Singapore outside its countries, G posted 20 days ago;
      // C states no country and D states no date or pay, so silence keeps them in.
      expect(page.queue.map((entry) => entry.jobId)).toEqual([ids.topFit, ids.tieRich, ids.tiePoor, ids.unscored]);
      expect(page.queue[0]).toMatchObject({ category: "Software engineering", applicationUrl: "https://jobs.lever.co/acme/123/apply", hourlyUsdPay: 30, latestVariantId: null });
      expect(page.queue[1]).toMatchObject({ category: "Data and AI", primaryLocation: "Austin, TX", countryCodes: ["US"] });
      expect(getReviewQueuePage(database, { view: "all" }, now).total).toBe(7);
    } finally { database.close(); }
  });

  it("applies saved focus settings without marking AI scores out of date", () => {
    const { database, ids } = focusWorkspace();
    try {
      const versions = Object.values(ids).map((id) => getFitInputVersion(database, id));
      saveReviewFocusSettings(database, { ...DEFAULT_REVIEW_FOCUS, categories: [], countries: ["US", "SG"], includeUnstatedCountry: false, minHourlyPay: 31 });
      expect(Object.values(ids).map((id) => getFitInputVersion(database, id))).toEqual(versions);
      const page = getReviewQueuePage(database, {}, now);
      // Software engineering stays; Singapore joins; C (no country) and A ($30/hr) drop out; D's unstated pay stays.
      expect(page.focus).toMatchObject({ categories: ["Software engineering"], minHourlyPay: 31 });
      expect(page.queue.map((entry) => entry.jobId)).toEqual([ids.abroad, ids.unscored]);
      expect(page.queue.every((entry) => entry.aiFit || entry.fitScore === null)).toBe(true);
      expect(() => saveReviewFocusSettings(database, { ...DEFAULT_REVIEW_FOCUS, postedWithinDays: 0 })).toThrow();
    } finally { database.close(); }
  });
});
