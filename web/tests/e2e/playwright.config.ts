import { defineConfig, devices } from "@playwright/test";

// The SPA is served by the real backend (Vite is not involved): the wheel's
// bundled web_dist is what ships, so the test boots what users get.
const PORT = Number(process.env.E2E_PORT ?? 5099);
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bash serve.sh",
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
