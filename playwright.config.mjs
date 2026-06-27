import { defineConfig } from '@playwright/test';

// E2E tests drive the real Electron app (no browser download needed — Electron
// ships its own Chromium). They cover the DOM/IPC-bound paths the headless
// golden/unit harness can't: app boot and the project save/restore round-trip.
export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
});
