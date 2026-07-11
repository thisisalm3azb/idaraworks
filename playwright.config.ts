import { defineConfig, devices } from "@playwright/test";

/**
 * E2E smoke pack (BUILD_BIBLE §13.6). Grows to: full loop + five field flows +
 * approvals inbox. Profiles: desktop + 375px mobile; RTL and throttled-3G
 * profiles join with i18n (Phase F) and the report flow (S3).
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile-375",
      use: { ...devices["Pixel 5"], viewport: { width: 375, height: 812 } },
    },
  ],
  webServer: {
    command: "pnpm start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
