// Shared Electron launcher for the e2e specs: fresh temp userData profile.
//
// Why: with the USER's real profile, the boot-time custom-texture-library scan
// can push hundreds of MB of dataURLs while Playwright's CDP debugger is
// attached — the DevTools connection buffer (256 MB) overflows and the test
// browser dies ("Target page, context or browser has been closed"). A clean
// profile removes that and makes runs reproducible.

import { _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launchApp(appRoot) {
  const userData = mkdtempSync(join(tmpdir(), 'bumpforge-e2e-'));
  const app = await electron.launch({
    args: [appRoot],
    env: { ...process.env, BF_TEST_USERDATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // Clean profile = first run → the welcome overlay may cover the viewport and
  // swallow canvas clicks. Dismiss it when present.
  const gotIt = page.locator('#welcome-got-it');
  await page.waitForTimeout(600);
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();

  return { app, page };
}
