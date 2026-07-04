import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchApp } from './launch.mjs';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Smoke test: the single highest-value E2E. It launches the actual Electron app
// and proves main.js (8k lines, not importable headless) still BOOTS after a
// refactor — the exact failure mode the golden/unit harness can't see.
//
// Requires a working WebGL/GPU: the app's Three.js viewer creates a WebGL
// context on boot. On a headless box with no GPU the renderer process crashes,
// so run this on a real desktop (or CI with GPU / ANGLE-swiftshader). See
// test/e2e/README.md.
test('app boots without uncaught errors and shows the viewer', async () => {
  const { app, page } = await launchApp(appRoot);
  try {
    const errors = [];
    let crashed = false;
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('crash', () => { crashed = true; });

    await expect(page).toHaveTitle(/bump|stl/i);

    // The viewer canvas (#viewport) is static in index.html but the WebGL
    // context is created by main.js initViewer(); if that throws or the GPU is
    // unavailable the renderer dies and this won't resolve.
    await expect(page.locator('#viewport')).toBeAttached();

    expect(crashed, 'renderer crashed during boot (WebGL/GPU unavailable?)').toBe(false);
    expect(errors, `uncaught errors during boot:\n${errors.join('\n')}`).toEqual([]);
  } finally {
    await app.close();
  }
});
