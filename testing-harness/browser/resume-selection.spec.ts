import { expect, test } from "@playwright/test";

test("an entry can be left off the printed resume and put back", async ({ page }) => {
  await page.goto("/resume");
  const projects = page.getByRole("region", { name: "Projects" });
  const entry = projects.getByTestId("resume-entry").first();
  await expect(entry.getByText("On resume", { exact: true })).toBeVisible();

  await entry.getByRole("button", { name: "Leave off resume" }).click();
  await expect(entry.getByText("Library only", { exact: true })).toBeVisible();
  await expect(projects).toContainText("0 of 1 on resume");
  await page.reload();
  await expect(projects.getByTestId("resume-entry").first().getByText("Library only", { exact: true })).toBeVisible();
  const preview = await page.request.get("/resume/preview");
  expect(preview.status()).toBe(200);

  await projects.getByTestId("resume-entry").first().getByRole("button", { name: "Put on resume" }).click();
  await expect(projects.getByTestId("resume-entry").first().getByText("On resume", { exact: true })).toBeVisible();
  await expect(projects).toContainText("1 of 1 on resume");
});
