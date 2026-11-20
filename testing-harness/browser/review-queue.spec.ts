import { competitivenessFixture } from "../matching/competitiveness-fixture";
import { randomUUID } from "node:crypto";
import { evaluateAndPersistMatch } from "@internship-agent/agent";
import { saveSemanticFit, getFitInputVersion, saveJobMatch, savePostingPublication, getDatabase, persistNormalizedPosting, setJobStatus } from "@internship-agent/db";
import { expect, test } from "@playwright/test";

async function rememberAnswer(
  page: import("@playwright/test").Page,
  question: string,
  answer: string,
  countryCode?: string
) {
  await page.goto("/profile");
  await page.getByLabel("Application question").fill(question);
  if (countryCode) await page.getByLabel(/Country code/).fill(countryCode);
  await page.getByRole("button", { name: "Check memory" }).click();
  await expect(page.getByTestId("needs-input")).toBeVisible();
  await page.getByLabel("Your answer").fill(answer);
  await page.getByRole("button", { name: "Use answer" }).click();
  await expect(page.getByTestId("memory-resolution")).toContainText("user");
}

test("a qualified posting travels from analysis to approval", async ({ page }) => {
  await rememberAnswer(page, "Are you legally authorized to work in the United States?", "yes", "US");
  await rememberAnswer(page, "Do you require sponsorship to work in the United States?", "no", "US");
  await rememberAnswer(page, "What is your available start date?", "2027-06-01");

  await page.goto("/evidence");
  const techClaim = page.locator(".claim-card").filter({ hasText: "declares typescript as a dependency" });
  await techClaim.getByRole("button", { name: "Allow" }).click();
  await expect(techClaim.getByText("ALLOWED", { exact: true })).toBeVisible();

  await page.goto("/jobs");
  const seeded = page.locator(".project-evidence").filter({ hasText: "Northstar Systems" });
  await seeded.locator(".job-card-summary").click();
  await seeded.getByRole("button", { name: /^(Analyze eligibility and fit|Re-analyze)$/ }).click();
  await expect(seeded.getByRole("heading", { name: /Qualified/ })).toBeVisible();

  await seeded.getByRole("button", { name: "Prepare application" }).click();
  await expect(seeded.getByRole("heading", { name: "Verified · ready for review" })).toBeVisible();

  await page.goto("/review");
  const queued = page.getByRole("region", { name: "Review Software Engineering Intern" });
  await expect(queued.getByText("ready for review")).toBeVisible();
  await queued.getByRole("button", { name: "Approve package" }).click();
  await expect(page.getByText("Queue is clear")).toBeVisible();

  await page.goto("/applications");
  const row = page.locator(".job-row").filter({ hasText: "Northstar Systems" });
  await expect(row.getByText("approved")).toBeVisible();
  await row.getByRole("link", { name: "Open detail" }).click();
  await expect(page.getByRole("heading", { name: "Software Engineering Intern" })).toBeVisible();
  await expect(page.getByText("Timeline").first()).toBeVisible();
  await expect(page.getByText("Stored job description snapshot")).toBeVisible();
  await expect(page.getByText("Source posting")).toBeVisible();
  // Verification reads as a summary; the per-check list stays folded until asked for.
  const checks = page.getByLabel("Verification checks");
  await expect(checks.getByText(/^\d+ checked, all supported/)).toBeVisible();
  await expect(checks).toContainText("resume line");
  const firstCheck = checks.locator(".reason-list li").first();
  await expect(firstCheck).toBeHidden();
  await checks.getByText("Show all checks").click();
  await expect(firstCheck).toBeVisible();

  // Each variant says whether it is the resume this application sends, and prints on request.
  const variant = page.getByTestId("resume-variant").first();
  await expect(variant).toContainText("Will be uploaded as a PDF");
  await variant.locator("summary").click();
  const href = await variant.getByRole("link", { name: "View PDF" }).getAttribute("href");
  const pdf = await page.request.get(href ?? "");
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");

  // A resume change marks the prepared package; refreshing rebuilds it and asks for approval again.
  const detailUrl = page.url();
  await page.goto("/resume");
  const project = page.getByRole("region", { name: "Projects" }).getByTestId("resume-entry").first();
  await project.getByRole("button", { name: "Leave off resume" }).click();
  await expect(project.getByText("Library only", { exact: true })).toBeVisible();
  await page.goto(detailUrl);
  await expect(page.getByText("Resume changed since prepared")).toBeVisible();
  await page.getByRole("button", { name: "Refresh with current resume" }).click();
  await expect(page.getByText("Resume changed since prepared")).toHaveCount(0);
  await expect(page.locator(".page-header .status-badge")).toHaveText("ready_for_review");
  await page.goto("/resume");
  await page.getByRole("region", { name: "Projects" }).getByTestId("resume-entry").first().getByRole("button", { name: "Put on resume" }).click();
  await page.goto("/review");
  await expect(page.getByText("Resume changed since prepared", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh all", exact: true }).click();
  await expect(page.getByText("Resume changed since prepared", { exact: true })).toHaveCount(0);
});


test("large lists stay bounded when navigating tabs and pages", async ({ page }) => {
  const database = getDatabase();
  const ids: string[] = [];
  const prefix = `Navigation ${randomUUID().slice(0, 8)}`;
  try {
    for (let index = 0; index < 121; index += 1) {
      const title = `${prefix} Intern ${index}`;
      const { jobId } = persistNormalizedPosting(database, {
        companyName: prefix, title, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
        sourceUrl: `https://example.test/navigation/${prefix}/${index}`, externalApplicationUrl: null, companyCareersUrl: null,
        contentHash: title, normalizedText: `${title}\nSynthetic navigation fixture.`, locations: [], compensation: null,
        requirements: [], technologies: [], constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
      });
      ids.push(jobId);
      setJobStatus(database, jobId, null, "READY_FOR_REVIEW", "Synthetic navigation fixture.");
    }
    await page.goto("/");
    await expect(page.locator(".job-row")).toHaveCount(20);
    await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Applications", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Applications", exact: true })).toBeVisible();
    await expect(page.locator(".job-row")).toHaveCount(50);
    await page.goto("/applications?status=READY_FOR_REVIEW");
    const pagination = page.getByRole("navigation", { name: "List pagination" });
    await pagination.getByRole("link", { name: "Next page" }).click();
    await expect(page).toHaveURL(/page=2.*status=READY_FOR_REVIEW/);
    await expect(page.locator(".job-row")).toHaveCount(50);
    await page.goBack();
    await expect(page).toHaveURL(/applications\?status=READY_FOR_REVIEW$/);
    await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Review Queue" }).click();
    // These fixtures are not in a focus category, so the full queue is one click away.
    await page.getByRole("navigation", { name: "Review views" }).getByRole("link", { name: /^All/ }).click();
    await expect(page.getByRole("region", { name: /^Review / })).toHaveCount(50);
    const selections = page.getByRole("form", { name: "Batch review feedback" });
    await expect(selections.getByRole("checkbox")).toHaveCount(50);
    await expect(selections).toContainText("on this page");
    await pagination.getByRole("link", { name: "Next page" }).click();
    await expect(page).toHaveURL(/review\?page=2.*sort=fit/);
    await expect(selections.getByRole("checkbox")).toHaveCount(50);
    const html = await page.request.get("/applications?status=READY_FOR_REVIEW");
    expect(Buffer.byteLength(await html.text())).toBeLessThan(400_000);
    await page.goto("/review?view=all&page=99999");
    await expect(pagination.getByRole("link", { name: "Next page" })).toHaveCount(0);
    await expect(pagination.getByRole("link", { name: "Previous page" })).toBeVisible();
  } finally {
    const remove = database.prepare("DELETE FROM jobs WHERE id = ?");
    for (const id of ids) remove.run(id);
  }
});


test("review fit and age controls preserve pagination, history, and page selections", async ({ page }) => {
  const database = getDatabase();
  const ids: string[] = [];
  const prefix = `Filter ${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  try {
    for (let index = 0; index < 63; index += 1) {
      const title = `${prefix} Intern ${index}`;
      const { jobId } = persistNormalizedPosting(database, {
        companyName: prefix, title, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
        sourceUrl: `https://example.test/review-filter/${prefix}/${index}`, externalApplicationUrl: null, companyCareersUrl: null,
        contentHash: title, normalizedText: `${title}\nSynthetic review filter fixture.`, locations: [], compensation: null,
        requirements: [], technologies: [], constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
      });
      ids.push(jobId);
      const { report } = evaluateAndPersistMatch(jobId, { database });
      saveJobMatch(database, { ...report, fitScore: index < 61 ? index : 99 });
      saveSemanticFit(database, jobId, getFitInputVersion(database,jobId), competitivenessFixture(index < 61 ? index : 99));
      setJobStatus(database, jobId, null, "READY_FOR_REVIEW", "Synthetic review filter fixture.");
      database.prepare("UPDATE jobs SET created_at = ? WHERE id = ?")
        .run(new Date(now - index * 1000).toISOString(), jobId);
      if (index !== 62) savePostingPublication(database, jobId, {
        postedAt: new Date(now - (index === 61 ? 7 * 86_400_000 : 3_600_000)).toISOString(),
        sourceUrl: "https://example.test/employer", field: "first_published", precision: "timestamp"
      });
    }
    await page.goto("/review?view=all");
    const controls = page.getByRole("group", { name: "Review queue controls" });
    await expect(controls.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue("fit");
    await controls.getByLabel("Posted within last (days)").fill("3");
    await controls.getByRole("button", { name: "Apply age filter" }).click();
    await expect(page).toHaveURL(/sort=fit.*days=3/);
    await expect(controls).toContainText("61 matching");
    await expect(controls).toContainText("unknown posting dates excluded");
    // These fixtures state no country, so "Not stated" keeps them all, and page links keep the choice.
    await controls.getByRole("combobox", { name: "Country", exact: true }).selectOption("none");
    await expect(page).toHaveURL(/sort=fit.*days=3.*country=none/);
    await expect(controls).toContainText("61 matching");
    await page.getByRole("navigation", { name: "List pagination" }).getByRole("link", { name: "Next page" }).click();
    await expect(page).toHaveURL(/page=2.*country=none/);
    await controls.getByRole("combobox", { name: "Country", exact: true }).selectOption("");
    await expect(page).toHaveURL(/review\?view=all&sort=fit&days=3$/);
    const entries = page.getByRole("region", { name: /^Review / });
    await expect(entries.first().getByRole("heading")).toHaveText(`${prefix} Intern 60`);
    await expect(entries.first()).toContainText("AI competitiveness 60/100");
    const pagination = page.getByRole("navigation", { name: "List pagination" });
    await pagination.getByRole("link", { name: "Next page" }).click();
    await expect(page).toHaveURL(/page=2.*sort=fit.*days=3/);
    const selections = page.getByRole("form", { name: "Batch review feedback" });
    await expect(selections.getByRole("checkbox")).toHaveCount(11);
    await expect(entries.first().getByRole("heading")).toHaveText(`${prefix} Intern 10`);
    await controls.getByRole("combobox", { name: "Sort", exact: true }).selectOption("newest");
    await expect(page).toHaveURL(/review\?view=all&sort=newest&days=3$/);
    await expect(entries.first().getByRole("heading")).toHaveText(`${prefix} Intern 0`);
    await pagination.getByRole("link", { name: "Next page" }).click();
    await controls.getByRole("button", { name: "Clear age filter" }).click();
    await expect(page).toHaveURL(/review\?view=all&sort=newest$/);
    await page.goBack();
    await expect(page).toHaveURL(/page=2.*sort=newest.*days=3/);
    await expect(controls.getByLabel("Posted within last (days)")).toHaveValue("3");
    await pagination.getByRole("link", { name: "Previous page" }).click();
    await selections.getByRole("checkbox", { name: `${prefix} Intern 0 · ${prefix}`, exact: true }).check();
    await selections.getByLabel("Reason", { exact: true }).fill("Synthetic page selection");
    await selections.getByRole("button", { name: "Skip selected", exact: true }).click();
    await expect(controls).toContainText("60 matching");
    await expect(entries.filter({ hasText: `${prefix} Intern 0` })).toHaveCount(0);
    const oldDate = JSON.stringify({ postedAt: new Date(now - 20 * 86_400_000).toISOString(),
      sourceUrl: "https://example.test/employer", field: "first_published", precision: "timestamp" });
    for (const id of ids) database.prepare("UPDATE jobs SET publication_json = ? WHERE id = ?").run(oldDate, id);
    await page.reload();
    await expect(page.getByRole("heading", { name: "No applications match this filter" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Queue is clear" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refresh all", exact: true })).toBeVisible();
  } finally {
    const remove = database.prepare("DELETE FROM jobs WHERE id = ?");
    for (const id of ids) remove.run(id);
  }
});

test("the focus view ranks focused postings, links straight to the application, and skips in two clicks", async ({ page }) => {
  const database = getDatabase();
  const unique = randomUUID().slice(0, 8);
  const ids: string[] = [];
  const add = (title: string, place: { raw: string; countryCode: string }, pay: string | null, external: string | null) => {
    const normalizedText = [title, place.raw, pay ?? "Pay not stated."].join("\n");
    const span = (raw: string) => ({ start: normalizedText.indexOf(raw), end: normalizedText.indexOf(raw) + raw.length, excerpt: raw });
    const { jobId } = persistNormalizedPosting(database, {
      companyName: `Focus Fixture ${unique}`, title, employmentType: "INTERNSHIP", applicationType: "EXTERNAL_ATS",
      sourceUrl: `https://example.test/focus/${unique}/${encodeURIComponent(title)}`, externalApplicationUrl: external, companyCareersUrl: null,
      contentHash: title, normalizedText, requirements: [], technologies: [],
      locations: [{ raw: place.raw, city: null, region: null, countryCode: place.countryCode, workMode: "UNSPECIFIED", span: span(place.raw) }],
      compensation: pay ? { raw: pay, minimum: 60, maximum: null, currency: "USD", period: "HOUR", span: span(pay) } : null,
      constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
    });
    setJobStatus(database, jobId, null, "READY_FOR_REVIEW", "Focus fixture.");
    savePostingPublication(database, jobId, { postedAt: new Date(Date.now() - 86_400_000).toISOString(),
      sourceUrl: "https://example.test/employer", field: "first_published", precision: "timestamp" });
    ids.push(jobId);
    return jobId;
  };
  try {
    const swe = add(`Platform Software Engineer Intern ${unique}`, { raw: "Austin, TX", countryCode: "US" }, "$60/hour", `https://jobs.lever.co/acme/${unique}`);
    saveSemanticFit(database, swe, getFitInputVersion(database, swe), competitivenessFixture(90));
    add(`Quantitative Trader Intern ${unique}`, { raw: "Chicago, IL", countryCode: "US" }, null, null);
    add(`Backend Developer Intern ${unique}`, { raw: "Singapore", countryCode: "SG" }, null, null);

    await page.goto("/review");
    const card = page.getByRole("region", { name: `Review Platform Software Engineer Intern ${unique}` });
    await expect(card).toContainText("$60/hr");
    await expect(card).toContainText("AI competitiveness 90/100");
    await expect(card.getByRole("link", { name: "Apply ↗" })).toHaveAttribute("href", `https://jobs.lever.co/acme/${unique}/apply`);
    await expect(page.getByRole("region", { name: `Review Quantitative Trader Intern ${unique}` })).toHaveCount(0);
    const abroad = page.getByRole("region", { name: `Review Backend Developer Intern ${unique}` });
    await expect(abroad).toHaveCount(0);

    // Adding a country to the focus brings its postings in; taking it out again restores the default.
    const settings = page.locator(".focus-settings");
    await settings.locator("summary").click();
    await settings.getByRole("checkbox", { name: /^Singapore/ }).check();
    await settings.getByRole("button", { name: "Save focus" }).click();
    await expect(abroad).toBeVisible();
    await settings.getByRole("checkbox", { name: /^Singapore/ }).uncheck();
    await settings.getByRole("button", { name: "Save focus" }).click();
    await expect(abroad).toHaveCount(0);

    await card.getByText("Not for me").click();
    await card.getByRole("button", { name: "Closed" }).click();
    await expect(card).toHaveCount(0);
    await page.getByRole("navigation", { name: "Review views" }).getByRole("link", { name: /^All/ }).click();
    const skipped = page.getByRole("region", { name: "Skipped postings" });
    await expect(skipped).toContainText(`Platform Software Engineer Intern ${unique} · Posting closed`);
  } finally {
    const remove = database.prepare("DELETE FROM jobs WHERE id = ?");
    for (const id of ids) remove.run(id);
  }
});
