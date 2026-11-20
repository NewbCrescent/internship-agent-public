import { expect, test } from "@playwright/test";

test("the graduate-internship exclusion is saved as a preference", async ({ page }) => {
  await page.goto("/profile");
  const exclusion = page.getByRole("checkbox", { name: "Exclude Master's and PhD internships" });
  await exclusion.check();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Preferences saved. They will not be treated as application answers.")).toBeVisible();
  await page.reload();
  await expect(exclusion).toBeChecked();
  await exclusion.uncheck();
  await page.getByRole("button", { name: "Save preferences" }).click();
});

test("a candidate can remember and safely reuse a scoped answer", async ({ page }) => {
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Profile & memory" })).toBeVisible();

  await page.getByLabel("Application question").fill("Would you consider relocating to Seattle?");
  await page.getByRole("button", { name: "Check memory" }).click();
  await expect(page.getByTestId("needs-input")).toBeVisible();

  await page.getByLabel("Your answer").fill("yes");
  await page.getByRole("button", { name: "Use answer" }).click();
  await expect(page.getByTestId("memory-resolution")).toContainText("Yes");
  await expect(page.getByTestId("memory-resolution")).toContainText("user");

  await page.reload();
  await page.getByLabel("Application question").fill("Are you willing to move to Seattle for this role?");
  await page.getByRole("button", { name: "Check memory" }).click();
  await expect(page.getByTestId("memory-resolution")).toContainText("Answered from memory");

  await page.getByLabel("Application question").fill("Would you relocate to Austin?");
  await page.getByRole("button", { name: "Check memory" }).click();
  await expect(page.getByTestId("needs-input")).toBeVisible();
  await expect(page.getByTestId("needs-input")).toContainText("No remembered willing to relocate fact exists for this scope");
});

test("contact details for applications are saved on the profile", async ({ page }) => {
  await page.goto("/profile");
  const contact = page.getByRole("group", { name: "Contact details for applications" });
  await contact.getByLabel("Legal first name").fill("Jordan");
  await contact.getByLabel("Legal last name").fill("Rivera");
  await contact.getByLabel("City").fill("Seattle");
  await contact.getByLabel("Phone type").selectOption("Mobile");
  await contact.getByLabel("Field of study").fill("Computer Science");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved locally.")).toBeVisible();
  await page.reload();
  await expect(contact.getByLabel("Legal first name")).toHaveValue("Jordan");
  await expect(contact.getByLabel("City")).toHaveValue("Seattle");
  await expect(contact.getByLabel("Phone type")).toHaveValue("Mobile");
  await expect(contact.getByLabel("Field of study")).toHaveValue("Computer Science");
  await contact.getByLabel("Legal first name").fill("");
  await contact.getByLabel("Legal last name").fill("");
  await contact.getByLabel("City").fill("");
  await contact.getByLabel("Phone type").selectOption("");
  await contact.getByLabel("Field of study").fill("");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved locally.")).toBeVisible();
});
