import { test, expect, _electron as electron } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';

// FreeCAD interop — FULL-CHAIN e2e (real app, real GPU, real files on disk):
//   load a tagged model (STL + sidecar found NEXT TO it via webUtils path)
//   → paint a selection → overwrite the file with a re-export (H+1mm variant)
//   → the LIVE LINK auto-reloads and re-matches the selection.
// This covers exactly the links the headless suite cannot: sidecar detection by
// path, live-link fs.watch → IPC → debounce → reload, and the UI selection
// rebuild. Fixtures are real FW Diorama exports (gothic arch, 244 BREP faces).

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = join(appRoot, 'test', 'fixtures', 'freecad');
const TMP = join(appRoot, 'test', 'e2e', '.tmp');

test('tagged model: sidecar detected, selection painted, live re-export re-matches it', async () => {
  test.setTimeout(90_000);

  // Working copy of variant A (the app will watch this exact path).
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  copyFileSync(join(FIX, 'interop_A.stl'), join(TMP, 'model.stl'));
  copyFileSync(join(FIX, 'interop_A.bumpforge-faces.json'), join(TMP, 'model.bumpforge-faces.json'));

  const app = await electron.launch({ args: [appRoot] });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#viewport')).toBeAttached();

    // ── 1. Load the tagged model through the real file input ──
    await page.setInputFiles('#stl-file-input', join(TMP, 'model.stl'));
    // Sidecar was found on disk next to the model + live link armed.
    await expect(page.locator('.toast', { hasText: /faces reconnues|faces recognized/i }))
      .toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.toast', { hasText: /lien vif|live link/i }))
      .toBeVisible({ timeout: 15_000 });

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

    // ── 3. Simulate the FreeCAD re-export: overwrite STL then sidecar ──
    copyFileSync(join(FIX, 'interop_C.stl'), join(TMP, 'model.stl'));
    copyFileSync(join(FIX, 'interop_C.bumpforge-faces.json'), join(TMP, 'model.bumpforge-faces.json'));

    // ── 4. Live link: auto-reload + selection re-matched, no clicks ──
    await expect(page.locator('.toast', { hasText: /ré-appariées|re-matched/i }))
      .toBeVisible({ timeout: 20_000 });
    await expect.poll(countText, { timeout: 10_000 }).toMatch(/[1-9]\d* faces/);
    const after = parseInt(await countText(), 10);
    // The H+1mm variant re-tessellates: counts may differ slightly, not vanish.
    expect(after).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(before * 0.5);

    const fatal = errors.filter(e => !/favicon|DevTools/i.test(e));
    expect(fatal, `uncaught errors:\n${fatal.join('\n')}`).toEqual([]);
  } finally {
    await app.close();
    rmSync(TMP, { recursive: true, force: true });
  }
});
