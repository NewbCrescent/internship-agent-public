import { expect, test } from "@playwright/test";

test("real and demo profiles keep their candidate, jobs, and evidence separate", async ({ page }) => {
  await page.goto("/profile");
  await expect(page.getByRole("form", { name: "Active profile" })).toContainText("Current profile: Demo");
  await expect(page.getByLabel("Full name")).toHaveValue("Jordan Rivera");

  await page.goto("/jobs");
  await expect(page.getByText("Northstar Systems", { exact: false }).first()).toBeVisible();
  await page.goto("/evidence");
  await expect(page.getByText("example-candidate/local-evidence-demo")).toBeVisible();

  await page.getByRole("button", { name: "Real", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/profile");
  await expect(page.getByRole("form", { name: "Active profile" })).toContainText("Current profile: Real");
  await expect(page.getByLabel("Full name")).toBeEmpty();
  await page.getByLabel("Full name").fill("Casey Test");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved locally.")).toBeVisible();

  // Base resumes belong to the active profile's own data directory.
  await page.reload();
  const resumes = page.getByTestId("base-resumes");
  await resumes.getByLabel("PDF file").setInputFiles({
    name: "resume-2029.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\n% fixture\n%%EOF\n")
  });
  await resumes.getByRole("button", { name: "Upload file" }).click();
  await expect(resumes.getByText(/Saved ".+" locally/)).toBeVisible();
  await expect(resumes.getByText(/resume-2029\.pdf/)).toBeVisible();
  await resumes.getByLabel("Use for").selectOption("transcript");
  await resumes.getByLabel("PDF file").setInputFiles({
    name: "transcript.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\n% fixture transcript\n%%EOF\n")
  });
  await resumes.getByRole("button", { name: "Upload file" }).click();
  await expect(resumes.getByText(/transcript\.pdf/)).toBeVisible();
  await expect(page.getByTestId("handshake-connection")).toContainText("Not connected");

  // Structured resume entries: typed entries are approved on save and print to a one-page PDF.
  await page.goto("/resume");
  await expect(page.getByRole("heading", { name: "Resume", exact: true })).toBeVisible();
  await page.getByLabel("Organization").fill("Aurora Labs");
  await page.getByLabel("Role").fill("Software Engineering Intern");
  await page.getByLabel(/Location/).fill("Berkeley, CA");
  await page.getByLabel(/^Date as written/).fill("2026");
  await page.getByLabel("Bullets (one per line)").fill("Built ingestion pipelines.\nShipped a dashboard.");
  await page.getByRole("button", { name: "Add entry" }).click();
  await expect(page.getByText("Entry added.")).toBeVisible();
  const experience = page.getByRole("region", { name: "Professional Experience" });
  await expect(experience.getByTestId("resume-entry")).toContainText("Aurora Labs");
  await expect(experience.getByTestId("resume-entry")).toContainText("Approved");
  await expect(experience.getByRole("listitem").filter({ hasText: "Shipped a dashboard." })).toBeVisible();
  const preview = await page.request.get("/resume/preview");
  expect(preview.status()).toBe(200);
  expect(preview.headers()["content-type"]).toBe("application/pdf");
  expect(preview.headers()["x-resume-pages"]).toBe("1");

  await page.goto("/jobs");
  await expect(page.getByText("No postings yet")).toBeVisible();
  await page.goto("/evidence");
  await expect(page.getByText("No repository evidence yet")).toBeVisible();

  await page.getByRole("button", { name: "Demo", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/profile");
  await expect(page.getByLabel("Full name")).toHaveValue("Jordan Rivera");
  await expect(page.getByTestId("base-resumes")).not.toContainText("resume-2029.pdf");
  await page.goto("/evidence");
  await expect(page.getByText("example-candidate/local-evidence-demo")).toBeVisible();
});
