import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, getJobPosting, getPlaceAndPay, persistNormalizedPosting, replacePlaceAndPay, savePostingPublication } from "@internship-agent/db";
import { backfillPlaceAndPay, normalizePostingText } from "@internship-agent/jobs";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function workspace(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-backfill-"));
  directories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

/** A posting stored before the extractor knew these formats: no location, no pay. */
function storedWithoutPlaceOrPay(database: DatabaseSync, title: string, content: string): string {
  const normalizedText = normalizePostingText(content);
  const jobId = persistNormalizedPosting(database, {
    companyName: "Backfill Fixture", title, employmentType: "INTERNSHIP", applicationType: "EXTERNAL_ATS",
    sourceUrl: `https://example.test/backfill/${encodeURIComponent(title)}`, externalApplicationUrl: null, companyCareersUrl: null,
    contentHash: `backfill-${title}`, normalizedText,
    locations: [], compensation: null, requirements: [], technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  }).jobId;
  database.prepare("UPDATE jobs SET status = 'READY_FOR_REVIEW' WHERE id = ?").run(jobId);
  return jobId;
}

describe("location and pay backfill", () => {
  it("reports without writing, applies only location and pay, and is idempotent", () => {
    const database = workspace();
    try {
      const singapore = storedWithoutPlaceOrPay(database, "Singapore Intern",
        "Software Engineer Intern\nLocation: Singapore\n\nThe U.S. pay range for this position is $45.00 - $55.00 hourly.");
      const unchanged = storedWithoutPlaceOrPay(database, "Silent Intern", "Software Engineer Intern\nWe build things.");
      const before = getJobPosting(database, singapore)!;

      const dryRun = backfillPlaceAndPay(database);
      expect(dryRun).toMatchObject({ applied: false, scanned: 2, changed: 1, lostCountry: 0, lostPay: 0 });
      expect(dryRun.before).toMatchObject({ withCountry: 0, withUsdPay: 0 });
      expect(dryRun.after).toMatchObject({ withCountry: 1, withUsdPay: 1, countries: { SG: 1 } });
      expect(dryRun.samples).toHaveLength(1);
      expect(getPlaceAndPay(database, singapore)).toEqual({ locations: [], compensation: null });

      const applied = backfillPlaceAndPay(database, { apply: true });
      expect(applied).toMatchObject({ applied: true, changed: 1 });
      const after = getJobPosting(database, singapore)!;
      expect(after.locations).toMatchObject([{ raw: "Singapore", countryCode: "SG" }]);
      expect(after.compensation).toMatchObject({ minimum: 45, maximum: 55, period: "HOUR", currency: "USD" });
      // Status, snapshot, and everything else stay as they were.
      expect(after.status).toBe("READY_FOR_REVIEW");
      expect(after.snapshot).toEqual(before.snapshot);
      expect(after.requirements).toEqual(before.requirements);
      expect(getPlaceAndPay(database, unchanged)).toEqual({ locations: [], compensation: null });

      expect(backfillPlaceAndPay(database, { apply: true })).toMatchObject({ changed: 0 });
    } finally { database.close(); }
  });

  it("limits a run to postings the employer published within the window, leaving unknown dates alone", () => {
    const database = workspace();
    try {
      const now = Date.parse("2026-10-13T12:00:00Z");
      const posted = (jobId: string, daysAgo: number) => savePostingPublication(database, jobId, {
        postedAt: new Date(now - daysAgo * 86_400_000).toISOString(), sourceUrl: "https://example.test/employer",
        field: "first_published", precision: "timestamp"
      });
      const fresh = storedWithoutPlaceOrPay(database, "Fresh Intern", "Software Engineer Intern\nLocation: Singapore");
      const boundary = storedWithoutPlaceOrPay(database, "Boundary Intern", "Software Engineer Intern\nLocation: Berlin, Germany");
      const old = storedWithoutPlaceOrPay(database, "Old Intern", "Software Engineer Intern\nLocation: Toronto, Ontario, Canada");
      const undated = storedWithoutPlaceOrPay(database, "Undated Intern", "Software Engineer Intern\nLocation: Belfast, United Kingdom");
      posted(fresh, 1);
      posted(boundary, 3);
      posted(old, 4);

      const report = backfillPlaceAndPay(database, { apply: true, postedWithinDays: 3, now });
      expect(report).toMatchObject({ applied: true, postedWithinDays: 3, scanned: 2, changed: 2 });
      expect(getPlaceAndPay(database, fresh).locations).toMatchObject([{ countryCode: "SG" }]);
      expect(getPlaceAndPay(database, boundary).locations).toMatchObject([{ countryCode: "DE" }]);
      expect(getPlaceAndPay(database, old).locations).toEqual([]);
      expect(getPlaceAndPay(database, undated).locations).toEqual([]);
    } finally { database.close(); }
  });

  it("refuses a location or pay span that does not quote the stored snapshot", () => {
    const database = workspace();
    try {
      const jobId = storedWithoutPlaceOrPay(database, "Quoted Intern", "Software Engineer Intern\nLocation: Singapore");
      expect(() => replacePlaceAndPay(database, jobId, {
        locations: [{ raw: "Berlin", city: "Berlin", region: null, countryCode: "DE", workMode: "UNSPECIFIED", span: { start: 0, end: 6, excerpt: "Berlin" } }],
        compensation: null
      })).toThrow(/does not quote/);
      expect(getPlaceAndPay(database, jobId)).toEqual({ locations: [], compensation: null });
    } finally { database.close(); }
  });
});
