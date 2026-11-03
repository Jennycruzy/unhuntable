import { defineConfig } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, browserName: "chromium" },
  projects: [
    { name: "phone", use: { viewport: { width: 360, height: 780 } } },
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: { command: "node test/server.mjs", url: `http://127.0.0.1:${PORT}/`, reuseExistingServer: false, env: { PORT: String(PORT) } },
});
