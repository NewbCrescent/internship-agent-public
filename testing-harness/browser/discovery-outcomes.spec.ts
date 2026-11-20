import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { getDatabase, persistNormalizedPosting, resolveProfileDataDirectory, setJobStatus } from "@internship-agent/db";

test("a selected GitHub list can be saved as a source without polling it", async ({ page }) => {
  await page.goto("/jobs");
  const sources = page.getByRole("region", { name: "Public internship boards" });
  await sources.getByLabel("Source label").fill("Summer 2027 internships");
  await sources.getByLabel("Job list or board URL").fill("https://github.com/SimplifyJobs/Summer2027-Internships");
  await sources.getByRole("button", { name: "Add board" }).click();
  await expect(sources.getByText("Public source saved locally.")).toBeVisible();
  const saved = sources.getByRole("listitem").filter({ hasText: "Summer 2027 internships" });
  await expect(saved.getByRole("link", { name: "View source" })).toHaveAttribute(
    "href", "https://github.com/SimplifyJobs/Summer2027-Internships"
  );
  await expect(saved.getByText(/last attempted/)).toHaveCount(0);
});

test("batch skip, restore, and employer update work in the dashboard", async ({ page }) => {
  const database = getDatabase();
  const unique = randomUUID();
  const title = `Browser Flow Intern ${unique.slice(0, 8)}`;
  const { jobId } = persistNormalizedPosting(database, {
    companyName: "Fixture Company",
    title,
    employmentType: "INTERNSHIP",
    applicationType: "UNKNOWN",
    sourceUrl: `https://example.test/browser-flow/${unique}`,
    externalApplicationUrl: null,
    companyCareersUrl: null,
    contentHash: unique,
    normalizedText: `${title}\nFixture posting for dashboard verification.`,
    locations: [],
    compensation: null,
    requirements: [],
    technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  });
  setJobStatus(database, jobId, null, "READY_FOR_REVIEW", "Fixture review state.");

  await page.goto("/review?view=all");
  const queue = page.getByRole("region", { name: `Review ${title}` });
  await expect(queue).toBeVisible();
  const batch = page.getByRole("form", { name: "Batch review feedback" });
  await batch.getByLabel(new RegExp(title)).check();
  await batch.getByLabel("Reason").fill("Fixture skip reason");
  await batch.getByRole("button", { name: "Skip selected" }).click();
  await expect(queue).toHaveCount(0);
  const skipped = page.getByRole("region", { name: "Skipped postings" });
  await expect(skipped.getByText(title)).toBeVisible();
  await skipped.getByRole("button", { name: "Restore to queue" }).click();
  await expect(queue).toBeVisible();

  setJobStatus(database, jobId, null, "SUBMITTED", "Fixture submission.");
  await page.goto(`/applications/${jobId}`);
  await page.getByLabel("Heard back").selectOption("OA");
  await page.getByLabel("Note (optional, 500 characters)").fill("Fixture assessment received.");
  await page.getByRole("button", { name: "Record update" }).click();
  await expect(page.getByText("Recorded oa.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Detailed employer outcomes" })).toContainText("Fixture assessment received.");
  await page.goto("/applications");
  await expect(page.getByRole("region", { name: "Detailed outcome stages" })).toContainText("oa: 1");
});

test("check board is disabled while a pipeline run holds the workspace lock", async ({ page }) => {
  const lock = join(resolveProfileDataDirectory("demo"), "pipeline.lock");
  await page.goto("/jobs");
  const sources = page.getByRole("region", { name: "Public internship boards" });
  await sources.getByLabel("Source label").fill("Locked board");
  await sources.getByLabel("Job list or board URL").fill("https://github.com/speedyapply/2027-SWE-College-Jobs");
  await sources.getByRole("button", { name: "Add board" }).click();
  await expect(sources.getByText("Public source saved locally.")).toBeVisible();

  // This test process is alive, so its pid stands in for a running pipeline.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    await page.reload();
    await expect(sources.getByRole("status")).toContainText("Check board is disabled until it finishes");
    for (const button of await sources.getByRole("button", { name: "Check board" }).all()) await expect(button).toBeDisabled();
    await expect(sources.getByRole("button", { name: "Add board" })).toBeEnabled();
  } finally {
    rmSync(lock, { force: true });
  }
  await page.reload();
  await expect(sources.getByRole("status")).toHaveCount(0);
  await expect(sources.getByRole("button", { name: "Check board" }).first()).toBeEnabled();
});
