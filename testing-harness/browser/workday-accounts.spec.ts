import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { getDatabase, persistNormalizedPosting, setJobStatus } from "@internship-agent/db";

test("the Workday accounts page lists sites with waiting applications and their sign-in state", async ({ page }) => {
  const database = getDatabase();
  const unique = randomUUID().slice(0, 8);
  const { jobId } = persistNormalizedPosting(database, {
    companyName: `Fixture Aerospace ${unique}`, title: "Software Intern", employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
    sourceUrl: `https://fixture${unique}.wd1.myworkdayjobs.com/External/job/US-VA/Software-Intern_R${unique}`,
    externalApplicationUrl: null, companyCareersUrl: null, contentHash: `workday-${unique}`,
    normalizedText: "Software Intern\nFixture Workday posting for the accounts page.",
    locations: [], compensation: null, requirements: [], technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  });
  setJobStatus(database, jobId, null, "READY_FOR_REVIEW", "Fixture review state.");
  try {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Workday accounts" }).click();
    await expect(page.getByRole("heading", { name: "Workday accounts" })).toBeVisible();
    const row = page.getByRole("listitem", { name: `Workday site Fixture Aerospace ${unique}` });
    await expect(row).toContainText(`fixture${unique}.wd1.myworkdayjobs.com`);
    await expect(row).toContainText("1 application waiting");
    await expect(row).toContainText("Not connected");
    // Clicking would open a real browser window; the sign-in flow is covered with a stub window in the local suite.
    await expect(row.getByRole("button", { name: "Open sign-in" })).toBeEnabled();
  } finally {
    database.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
  }
});
