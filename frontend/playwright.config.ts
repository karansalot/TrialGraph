import { defineConfig } from "@playwright/test";

// E2E tests run against a live stack (API + loaded database + web). Start both with `make dev`
// or let CI start them. BASE_URL defaults to the local dev server.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3010",
    viewport: { width: 1400, height: 900 },
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
    trace: "retain-on-failure",
  },
});
