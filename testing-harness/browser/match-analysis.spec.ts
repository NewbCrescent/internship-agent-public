import { expect, test } from "@playwright/test";

test("a candidate can analyze a posting and read the verdict with reasons", async ({ page }) => {
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();

  const seeded = page.locator(".project-evidence").filter({ hasText: "Northstar Systems" });
  await expect(seeded.getByRole("heading", { name: "Software Engineering Intern" })).toBeVisible();
  await seeded.locator(".job-card-summary").click();

  // Before analysis the panel offers a deterministic run, never a model call.
  await expect(seeded.getByText("No eligibility analysis yet.")).toBeVisible();
  await seeded.getByRole("button", { name: "Analyze eligibility and fit" }).click();

  // The seeded candidate records no work-authorization fact, so the stated
  // authorization constraint pauses rather than decides.
  await expect(seeded.getByRole("heading", { name: /Needs review/ })).toBeVisible();
  await expect(seeded.getByText(/checks? needs? your input before this verdict is final/)).toBeVisible();
  await seeded.getByText(/Secondary keyword estimate:/).click();
  await expect(seeded.locator(".reason-list").getByText(/Technology coverage/)).toBeVisible();

  // Re-analysis replaces the report instead of duplicating it.
  await seeded.getByRole("button", { name: "Re-analyze" }).click();
  await expect(seeded.getByRole("heading", { name: /Needs review/ })).toBeVisible();
  await expect(seeded.locator(".match-panel")).toHaveCount(1);
});


test("AI fit failure stays explicit without changing the local analysis", async ({ page }) => {
  await page.goto("/jobs");
  const card = page.locator(".project-evidence").filter({ hasText: "Northstar Systems" });
  await card.locator(".job-card-summary").click();
  await card.getByRole("button", { name: "Analyze fit with AI", exact: true }).click();
  await expect(card.getByRole("status")).toContainText("AI fit is unavailable");
  await expect(card.getByRole("button", { name: "Re-analyze", exact: true })).toBeVisible();
});
