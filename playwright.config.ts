import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./testing-harness/browser",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: process.env.INTERNSHIP_AGENT_BASE_URL ?? "http://127.0.0.1:3100",
    trace: "retain-on-failure"
  },
  reporter: [["list"]]
});
