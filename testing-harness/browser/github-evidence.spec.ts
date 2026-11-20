import { expect, test } from "@playwright/test";

test("a candidate can review source-backed GitHub claims", async ({ page }) => {
  await page.goto("/evidence");
  await expect(page.getByRole("heading", { name: "GitHub evidence" })).toBeVisible();
  await expect(page.getByText("local-evidence-demo", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Awaiting review").locator(".." ).getByText("2", { exact: true })).toBeVisible();

  const projectClaim = page.locator(".claim-card").filter({ hasText: "fictional local-first internship workflow demo" });
  await expect(projectClaim.getByRole("link", { name: "README.md:3" })).toHaveAttribute("href", /1111111.*README\.md#L3$/);
  await projectClaim.getByRole("button", { name: "Allow" }).click();
  await expect(projectClaim.getByText("ALLOWED", { exact: true })).toBeVisible();
  await expect(page.getByText("Verified claims").locator("..").getByText("1", { exact: true })).toBeVisible();
});
