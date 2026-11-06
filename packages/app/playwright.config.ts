// packages/app/playwright.config.ts — #410 P5b part 2a.
// Chromium-only, single-worker console e2e run against the fixture
// harness. Import-safe with no out/web present: the module body touches
// no fs and cannot exit — the dist preflight lives in serve.ts, so the
// required check.yml `bun run --cwd packages/app test` never needs the
// web build. baseURL is 127.0.0.1 because checkConsoleHost answers
// 421 to every other Host header.

import { defineConfig, devices } from "@playwright/test";

import { E2E_CONSOLE_PORT } from "./e2e/harness/fixtures/seed";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env["CI"],
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${String(E2E_CONSOLE_PORT)}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun e2e/harness/serve.ts",
    url: `http://127.0.0.1:${String(E2E_CONSOLE_PORT)}`,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
