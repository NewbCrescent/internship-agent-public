import { competitivenessFixture } from "../matching/competitiveness-fixture";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { evaluateAndPersistMatch } from "@internship-agent/agent";
import { getDatabase, persistNormalizedPosting, saveSemanticFit, getFitInputVersion } from "@internship-agent/db";

const POSTING = `Platform Engineering Intern
Helio Works - Denver, CO

Minimum qualifications:
- Must be enrolled in a Bachelor's degree program in Computer Science
- Experience with Go and Docker

Preferred qualifications:
- Kubernetes experience preferred

Compensation: $40 - $55 per hour.
Applicants must be legally authorized to work in the United States.
`;

test("the seeded posting shows stated requirements and marks silence as unknown", async ({ page }) => {
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();

  const seeded = page.locator(".project-evidence").filter({ hasText: "Software Engineering Intern" });
  await expect(seeded.getByRole("heading", { name: "Software Engineering Intern" })).toBeVisible();
  // Cards start collapsed; the summary row opens one.
  await expect(seeded.locator(".constraint-summary")).toBeHidden();
  await seeded.locator(".job-card-summary").click();

  // A hard requirement quotes the stored snapshot rather than paraphrasing it.
  const hardGroup = seeded.locator(".requirement-group").filter({ hasText: "Hard requirements" });
  await expect(hardGroup.getByText("Must be enrolled in a Bachelor's degree program in Computer Science or a related field")).toBeVisible();
  await expect(hardGroup.getByText(/^verbatim, chars \d+–\d+$/).first()).toBeVisible();
  // The confidence shown is about reading the posting, never about the candidate meeting it.
  await expect(hardGroup.getByText(/^reading confidence \d+%$/).first()).toBeVisible();

  // The posting states authorization but says nothing about sponsorship.
  const constraints = seeded.locator(".constraint-summary");
  await expect(constraints.getByText("Existing authorization required (US)")).toBeVisible();
  await expect(constraints.getByText(/Not stated:.*sponsorship/)).toBeVisible();
});

test("a candidate can paste a posting and see it normalized", async ({ page }) => {
  await page.goto("/jobs");

  await page.getByLabel("Company", { exact: true }).fill("Helio Works");
  await page.getByLabel("Title", { exact: true }).fill("Platform Engineering Intern");
  await page.getByLabel("Source URL").fill("https://app.joinhandshake.com/jobs/770077");
  await page.getByLabel("Posting content").fill(POSTING);
  await page.getByRole("button", { name: "Ingest posting" }).click();

  await expect(page.locator(".form-message.success")).toContainText("hard and");

  const posting = page.locator(".project-evidence").filter({ hasText: "Platform Engineering Intern" });
  await posting.locator(".job-card-summary").click();
  await expect(posting.getByText("Handshake application")).toBeVisible();
  await expect(posting.locator(".job-card-meta")).toContainText("Denver, CO");
  await expect(posting.locator(".posting-facts").getByText("Denver, CO", { exact: false })).toBeVisible();
  await expect(posting.getByText("$40–$55 per hour")).toBeVisible();

  const preferred = posting.locator(".requirement-group").filter({ hasText: "Preferred qualifications" });
  await expect(preferred.getByText("Kubernetes experience preferred")).toBeVisible();

  // Re-pasting identical content is recognized rather than duplicated.
  await page.getByLabel("Company", { exact: true }).fill("Helio Works");
  await page.getByLabel("Title", { exact: true }).fill("Platform Engineering Intern");
  await page.getByLabel("Source URL").fill("https://app.joinhandshake.com/jobs/770077");
  await page.getByLabel("Posting content").fill(POSTING);
  await page.getByRole("button", { name: "Ingest posting" }).click();

  await expect(page.locator(".form-message.success")).toContainText("already stored");
  await expect(page.locator(".project-evidence").filter({ hasText: "Platform Engineering Intern" })).toHaveCount(1);
});

test("expand all and collapse all toggle every job card", async ({ page }) => {
  await page.goto("/jobs");
  const cards = page.locator("details.job-card");
  await expect(cards.first()).not.toHaveAttribute("open");
  await page.getByRole("button", { name: "Expand all" }).click();
  for (const card of await cards.all()) await expect(card).toHaveAttribute("open");
  await expect(cards.first().locator(".match-panel")).toBeVisible();
  await page.getByRole("button", { name: "Collapse all" }).click();
  for (const card of await cards.all()) await expect(card).not.toHaveAttribute("open");
});

test("the list sorts by fit by default and filters by category", async ({ page }) => {
  const database = getDatabase();
  const unique = randomUUID().slice(0, 8);
  for (const title of [`Quantitative Research Intern ${unique}`, `Security Engineering Intern ${unique}`]) {
    const { jobId } = persistNormalizedPosting(database, {
      companyName: "Fixture Capital", title, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
      sourceUrl: `https://example.test/job-list/${encodeURIComponent(title)}`, externalApplicationUrl: null, companyCareersUrl: null,
      contentHash: `${unique}-${title}`, normalizedText: `${title}\nFixture posting for the Jobs list controls.`,
      locations: [], compensation: null, requirements: [], technologies: [],
      constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
    });
    evaluateAndPersistMatch(jobId, { database });
    saveSemanticFit(database, jobId, getFitInputVersion(database,jobId), competitivenessFixture(title.startsWith("Quant") ? 80 : 60));
  }

  await page.goto("/jobs");
  const controls = page.getByLabel("Job list controls");
  await expect(controls.getByLabel("Sort")).toHaveValue("fit");
  // Fit scores never increase down the list, and unanalyzed postings come last.
  const fits = (await page.locator(".job-card-meta").allInnerTexts()).map((text) => /AI competitiveness (\d+)\/100/.exec(text)?.[1]);
  const scores = fits.map((fit) => (fit === undefined ? -1 : Number(fit)));
  expect(scores.filter((score) => score >= 0).length).toBeGreaterThanOrEqual(2);
  expect(scores).toEqual([...scores].sort((a, b) => b - a));

  await controls.getByLabel("Category").selectOption("Quant and finance");
  await expect(page).toHaveURL(/category=Quant\+and\+finance/);
  await expect(page.locator("details.job-card")).toHaveCount(1);
  await expect(page.locator("details.job-card h2")).toHaveText(`Quantitative Research Intern ${unique}`);
  await expect(controls).toContainText("Showing 1–1 of 1");

  await controls.getByLabel("Sort").selectOption("newest");
  await expect(page).toHaveURL(/sort=newest/);
  await expect(page).toHaveURL(/category=Quant\+and\+finance/);
  await controls.getByLabel("Category").selectOption("");
  await expect(page).toHaveURL(/\/jobs\?sort=newest$/);
});

test("the list shows 50 postings per page and a filter change returns to page 1", async ({ page }) => {
  const database = getDatabase();
  const unique = randomUUID().slice(0, 8);
  const created: string[] = [];
  for (let index = 0; index < 55; index += 1) {
    const title = `Pagination Fixture Intern ${unique} ${index}`;
    created.push(persistNormalizedPosting(database, {
      companyName: "Fixture Pages", title, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
      sourceUrl: `https://example.test/pages/${unique}/${index}`, externalApplicationUrl: null, companyCareersUrl: null,
      contentHash: `${unique}-${index}`, normalizedText: `${title}\nFixture posting for Jobs pagination.`,
      locations: [], compensation: null, requirements: [], technologies: [],
      constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
    }).jobId);
  }
  // Later specs share this workspace and expect the seeded posting on page 1.
  try {
    await checkPagination(page);
  } finally {
    const remove = database.prepare("DELETE FROM jobs WHERE id = ?");
    for (const jobId of created) remove.run(jobId);
  }
});

async function checkPagination(page: import("@playwright/test").Page) {
  await page.goto("/jobs");
  const controls = page.getByLabel("Job list controls");
  const pages = controls.getByRole("navigation", { name: "Job pages" });
  await expect(page.locator("details.job-card")).toHaveCount(50);
  await expect(controls).toContainText("Showing 1–50 of");
  await expect(pages.getByRole("button", { name: "Previous" })).toBeDisabled();

  // A new page keeps the window where it is, so the list stays under the toolbar
  // instead of jumping back above the posting forms.
  await controls.evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 20));
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);
  await pages.getByRole("button", { name: "Next" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(controls).toContainText("Showing 51–");
  expect(Math.abs(await page.evaluate(() => window.scrollY) - scrolled)).toBeLessThanOrEqual(1);
  await expect(pages).toContainText("Page 2 of");
  expect(await page.locator("details.job-card").count()).toBeGreaterThan(0);
  expect(await page.locator("details.job-card").count()).toBeLessThanOrEqual(50);

  await controls.getByLabel("Category").selectOption("Other");
  await expect(page).not.toHaveURL(/page=/);
  await expect(pages).toContainText("Page 1 of");
}


test("employer posting age filters combine with category and sorting and can be cleared", async ({ page }) => {
  const database = getDatabase();
  const unique = randomUUID().slice(0, 8);
  for (const [name, age] of [["Fresh", 1], ["Old", 10], ["Unknown", null]] as const) {
    const title = `${name} Security Intern ${unique}`;
    persistNormalizedPosting(database, {
      companyName: "Date Fixture", title, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
      sourceUrl: `https://example.test/age/${unique}/${name}`, externalApplicationUrl: null, companyCareersUrl: null,
      contentHash: title, normalizedText: title, locations: [], compensation: null, requirements: [], technologies: [],
      constraints: { graduation: null, authorization: null, sponsorship: null, availability: null },
      publication: age === null ? null : { postedAt: new Date(Date.now() - age * 86400000).toISOString(), sourceUrl: `https://example.test/age/${unique}/${name}`, field: "first_published", precision: "timestamp" }
    });
  }
  await page.goto("/jobs?category=Security&sort=newest");
  const controls = page.getByLabel("Job list controls");
  await controls.getByLabel("Posted within last (days)").fill("3");
  await controls.getByRole("button", { name: "Apply age filter" }).click();
  await expect(page).toHaveURL(/days=3/);
  await expect(page).toHaveURL(/category=Security/);
  await expect(page).toHaveURL(/sort=newest/);
  await expect(page.locator("details.job-card h2")).toHaveText(`Fresh Security Intern ${unique}`);
  await expect(controls).toContainText("unknown posting dates excluded");
  await page.reload();
  await expect(controls.getByLabel("Posted within last (days)")).toHaveValue("3");
  await controls.getByLabel("Sort").selectOption("fit");
  await expect(page).toHaveURL(/days=3/);
  await controls.getByRole("button", { name: "Clear age filter" }).click();
  await expect(page).not.toHaveURL(/days=/);
  for (const name of ["Fresh", "Old", "Unknown"]) await expect(page.locator("details.job-card h2").filter({ hasText: `${name} Security Intern ${unique}` })).toBeVisible();
});

test("country and minimum-pay filters narrow the Jobs list, stay in the URL, and can be cleared", async ({ page }) => {
  const database = getDatabase();
  const unique = randomUUID().slice(0, 8);
  const fixtures = [
    { name: "Singapore", place: { raw: "Singapore", countryCode: "SG" }, pay: null },
    { name: "Wellpaid", place: { raw: "Austin, TX", countryCode: "US" }, pay: { raw: "$60/hour", minimum: 60 } },
    { name: "Lowpaid", place: { raw: "Denver, CO", countryCode: "US" }, pay: { raw: "$20/hour", minimum: 20 } }
  ];
  for (const fixture of fixtures) {
    const title = `${fixture.name} Security Intern ${unique}`;
    const normalizedText = [title, fixture.place.raw, fixture.pay?.raw ?? "Pay not stated."].join("\n");
    const span = (raw: string) => ({ start: normalizedText.indexOf(raw), end: normalizedText.indexOf(raw) + raw.length, excerpt: raw });
    persistNormalizedPosting(database, {
      companyName: "Filter Fixture", title, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
      sourceUrl: `https://example.test/filters/${unique}/${fixture.name}`, externalApplicationUrl: null, companyCareersUrl: null,
      contentHash: title, normalizedText, requirements: [], technologies: [],
      locations: [{ raw: fixture.place.raw, city: null, region: null, countryCode: fixture.place.countryCode, workMode: "UNSPECIFIED", span: span(fixture.place.raw) }],
      compensation: fixture.pay ? { raw: fixture.pay.raw, minimum: fixture.pay.minimum, maximum: null, currency: "USD", period: "HOUR", span: span(fixture.pay.raw) } : null,
      constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
    });
  }
  const cards = page.locator("details.job-card h2").filter({ hasText: unique });
  await page.goto("/jobs?category=Security&sort=newest");
  const controls = page.getByLabel("Job list controls");
  await expect(cards).toHaveCount(3);

  await controls.getByLabel("Country").selectOption("SG");
  await expect(page).toHaveURL(/country=SG/);
  await expect(page).toHaveURL(/category=Security/);
  await expect(cards).toHaveText([`Singapore Security Intern ${unique}`]);
  await controls.getByLabel("Country").selectOption("");
  await expect(page).not.toHaveURL(/country=/);

  await controls.getByLabel("Min pay ($/hr)").fill("50");
  await controls.getByRole("button", { name: "Apply pay filter" }).click();
  await expect(page).toHaveURL(/minPay=50/);
  await expect(cards).toHaveText([`Wellpaid Security Intern ${unique}`]);
  await expect(controls).toContainText("without stated USD pay excluded");
  await page.reload();
  await expect(controls.getByLabel("Min pay ($/hr)")).toHaveValue("50");
  await controls.getByRole("button", { name: "Clear pay filter" }).click();
  await expect(page).not.toHaveURL(/minPay=/);
  await expect(cards).toHaveCount(3);
});
