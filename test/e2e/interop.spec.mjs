import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { launchApp } from './launch.mjs';

// FreeCAD interop — FULL-CHAIN e2e (real app, real GPU, real files on disk),
// run for BOTH pipelines:
//   STL  — model + .bumpforge-faces.json sidecar found NEXT TO it (webUtils path)
//   STEP — direct import through the vendored meshStep (in-memory face table)
// Scenario: load tagged model → paint a selection → overwrite the file with a
// re-export (H+1mm variant) → the LIVE LINK auto-reloads and re-matches the
// selection. Covers exactly what the headless suite cannot: path-based sidecar
// detection, fs.watch → IPC → debounce → reload, and the UI selection rebuild.
// Fixtures are real FW Diorama exports (gothic arch, 244 BREP faces, 24 stones).

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = join(appRoot, 'test', 'fixtures', 'freecad');
const TMP = join(appRoot, 'test', 'e2e', '.tmp');

const PIPELINES = {
  stl: {
    stage(variant) {
      copyFileSync(join(FIX, `interop_${variant}.stl`), join(TMP, 'model.stl'));
      copyFileSync(join(FIX, `interop_${variant}.bumpforge-faces.json`),
                   join(TMP, 'model.bumpforge-faces.json'));
    },
    modelFile: 'model.stl',
  },
  step: {
    stage(variant) {
      copyFileSync(join(FIX, `interop_${variant}.step`), join(TMP, 'model.step'));
    },
    modelFile: 'model.step',
  },
};

for (const [name, pipe] of Object.entries(PIPELINES)) {
  test(`${name}: tagged load, painted selection, live re-export re-matches it`, async () => {
    test.setTimeout(90_000);

    // Working copy of variant A (the app will watch this exact path).
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    pipe.stage('A');

    const { app, page } = await launchApp(appRoot);
    try {
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await expect(page.locator('#viewport')).toBeAttached();

      // ── 1. Load the tagged model through the real file input ──
      await page.setInputFiles('#stl-file-input', join(TMP, pipe.modelFile));
      await expect(page.locator('.toast', { hasText: /faces reconnues|faces recognized/i }))
        .toBeVisible({ timeout: 20_000 });
      await expect(page.locator('.toast', { hasText: /lien vif|live link/i }))
        .toBeVisible({ timeout: 20_000 });

      // ── 2. Paint a selection (include-only + bucket fill) ──
      // The arch is a FRAME: its centre is the opening (void), so probe several
      // spots (sill at the bottom, jambs at the sides) until one click lands.
      await page.locator('#excl-mode-include').click();
      await page.locator('#excl-bucket-btn').click();
      const vp = await page.locator('#viewport').boundingBox();
      const countText = () => page.locator('#excl-count').textContent();
      const hasFaces = async () => /[1-9]\d* faces/.test((await countText()) || '');
      for (const [fx, fy] of [[0.5, 0.78], [0.34, 0.5], [0.66, 0.5], [0.5, 0.22], [0.42, 0.6]]) {
        await page.mouse.click(vp.x + vp.width * fx, vp.y + vp.height * fy);
        await page.waitForTimeout(400);
        if (await hasFaces()) break;
      }
      expect(await hasFaces(), 'no probe click landed on the arch').toBe(true);
      const before = parseInt(await countText(), 10);

      // ── 3. Simulate the FreeCAD re-export: overwrite the watched file(s) ──
      pipe.stage('C');

      // ── 4. Live link: auto-reload + selection re-matched, no clicks ──
      await expect(page.locator('.toast', { hasText: /ré-appariées|re-matched/i }))
        .toBeVisible({ timeout: 25_000 });
      await expect.poll(countText, { timeout: 10_000 }).toMatch(/[1-9]\d* faces/);
      const after = parseInt(await countText(), 10);
      // The H+1mm variant re-tessellates: counts may differ, not vanish.
      expect(after).toBeGreaterThan(0);
      expect(after).toBeGreaterThan(before * 0.4);

      const fatal = errors.filter(e => !/favicon|DevTools/i.test(e));
      expect(fatal, `uncaught errors:\n${fatal.join('\n')}`).toEqual([]);
    } finally {
      await app.close();
      rmSync(TMP, { recursive: true, force: true });
    }
  });
}
