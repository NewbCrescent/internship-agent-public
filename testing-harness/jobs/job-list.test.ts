import { describe, expect, it } from "vitest";

import { roleTypeForTitle, type JobPosting } from "@internship-agent/domain";
import { arrangePostings, categoryCounts, filterByPostingAge, parseJobListOptions } from "@internship-agent/jobs";

const posting = (id: string, title: string) => ({ id, title }) as unknown as JobPosting;

describe("job categories", () => {
  it.each([
    ["Software Engineering Intern", "Software engineering"],
    ["Cyber ServiceNow Developer Intern - Summer 2027", "Security"],
    ["Cloud Security Intern", "Security"],
    ["Quant Developer / Quant Research Intern - 2026/2027", "Quant and finance"],
    ["Quantitative Research Intern", "Quant and finance"],
    ["Summer Intern - Quantitative Risk Management", "Quant and finance"],
    ["Data Science Intern (2027)", "Data and AI"],
    ["Intern, Deep Learning Engineer", "Data and AI"],
    ["(PALM) and Artificial Intelligence Co-Op", "Data and AI"],
    ["Year-Round Intern - Cloud Engineering", "Cloud and infrastructure"],
    ["Supercomputing Intern", "Cloud and infrastructure"],
    ["Summer 2027 Autonomy & Robotics Engineering Intern", "Robotics and hardware"],
    ["Research Scientist, Multiscale Modeling Summer 2027 Intern", "Research"],
    ["Computer Science Internship Summer 2027", "Software engineering"],
    ["Product Manager Intern", "Product"],
    ["UX Design Intern", "Design"],
    ["Engineering Summer Internship Programme", "Other"],
    ["Technology Intern - Richmond, VA (Summer 2027)", "Other"]
  ])("%s → %s", (title, category) => {
    expect(roleTypeForTitle(title)).toBe(category);
  });
});

describe("job list arrangement", () => {
  const postings = [
    posting("a", "Software Engineering Intern"),
    posting("b", "Quantitative Research Intern"),
    posting("c", "Data Science Intern"),
    posting("d", "Backend Software Intern"),
    posting("e", "Quant Trading Intern")
  ];
  const fits: Record<string, number | null> = { a: 40, b: 55, c: null, d: 55, e: 12 };
  const fitOf = (id: string) => fits[id] ?? null;

  it("sorts by fit high to low, newest first among ties, unanalyzed last", () => {
    expect(arrangePostings(postings, fitOf, { sort: "fit", category: null }).map((entry) => entry.id)).toEqual(["b", "d", "a", "e", "c"]);
    expect(arrangePostings(postings, fitOf, { sort: "newest", category: null }).map((entry) => entry.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("filters by category and counts categories in display order", () => {
    expect(arrangePostings(postings, fitOf, { sort: "fit", category: "Quant and finance" }).map((entry) => entry.id)).toEqual(["b", "e"]);
    expect(categoryCounts(postings)).toEqual([
      { category: "Software engineering", count: 2 },
      { category: "Data and AI", count: 1 },
      { category: "Quant and finance", count: 2 }
    ]);
  });

  it("defaults to fit, all categories, and page 1, rejecting unknown query values", () => {
    const unfiltered = { postedWithinDays: null, country: null, minHourlyPay: null };
    expect(parseJobListOptions({})).toEqual({ sort: "fit", category: null, ...unfiltered, page: 1 });
    expect(parseJobListOptions({ sort: "newest", category: "Security", page: "3" })).toEqual({ sort: "newest", category: "Security", ...unfiltered, page: 3 });
    expect(parseJobListOptions({ sort: "random", category: "<script>", page: "-2" })).toEqual({ sort: "fit", category: null, ...unfiltered, page: 1 });
    expect(parseJobListOptions({ sort: ["newest", "fit"], category: ["Research"], page: ["0"] })).toEqual({ sort: "newest", category: "Research", ...unfiltered, page: 1 });
    expect(parseJobListOptions({ page: "abc" }).page).toBe(1);
    expect(parseJobListOptions({ country: "sg", minPay: "45.50" })).toMatchObject({ country: "SG", minHourlyPay: 45.5 });
    expect(parseJobListOptions({ country: "Singapore", minPay: "free" })).toMatchObject({ country: null, minHourlyPay: null });
  });
});

describe("employer posting age", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const entry = (id: string, postedAt: string | null, title = "Software Intern") => ({
    id, title, createdAt: "2026-10-06T12:00:00Z",
    publication: postedAt ? { postedAt, sourceUrl: "https://example.test/jobs", field: "first_published" as const, precision: "timestamp" as const } : null
  });
  it("includes the exact 72-hour boundary and excludes older, future, and unknown dates despite a fresh import", () => {
    const jobs = [entry("boundary", "2026-10-03T12:00:00Z"), entry("old", "2026-10-03T11:59:59Z"), entry("new", "2026-10-06T12:00:00Z"), entry("future", "2026-10-06T12:00:01Z"), entry("unknown", null)];
    expect(filterByPostingAge(jobs, 3, now).map(j => j.id)).toEqual(["boundary", "new"]);
    expect(filterByPostingAge(jobs, null, now)).toEqual(jobs);
    expect(arrangePostings([...jobs, entry("quant", "2026-10-05T12:00:00Z", "Quant Intern")], () => 50, { sort: "fit", category: "Quant and finance", postedWithinDays: 3 }, now).map(j => j.id)).toEqual(["quant"]);
  });
  it("validates the days URL parameter", () => {
    expect(parseJobListOptions({ days: ["3", "7"] }).postedWithinDays).toBe(3);
    for (const days of ["0", "-3", "1.5", "366", "abc", ""]) expect(parseJobListOptions({ days }).postedWithinDays).toBeNull();
  });
});
