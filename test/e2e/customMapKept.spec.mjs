import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchApp } from './launch.mjs';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Une carte PERSONNALISEE ne doit pas etre remplacee par le preset par defaut
// au demarrage.
//
// LE DEFAUT, mesure sur un projet reel (house.bforge, 22 slots) : 3 slots
// portaient `activeMapType: 'preset'` / `'Crystal'` alors que leur
// `customMapDataUrl` de 893 Ko etait toujours dans le fichier. La texture
// n'etait donc pas perdue — seul son POINTEUR avait ete ecrase, puis
// re-sauvegarde. Une session, un slot.
//
// LA CAUSE : le bloc de selection initiale vit dans le `.then()` de
// `loadAllThumbnails()`. Quand la derniere carte active etait personnalisee,
// elle n'est pas dans IMAGE_PRESETS, la recherche echoue, et le code repliait
// sur DEFAULT_PRESET_NAME. Comme il s'execute APRES la restauration, il passait
// par-dessus.
//
// ⚠️ Ce test ne peut pas vivre en headless : la sequence est un `.then()` de
// main.js, non importable. On seme donc sessionStorage puis on RECHARGE, ce qui
// rejoue exactement le chemin de demarrage.
test('une carte personnalisee n\'est pas remplacee par le preset par defaut', async () => {
  const { app, page } = await launchApp(appRoot);
  try {
    // Etat « la derniere carte active etait personnalisee » : un nom qui
    // n'existe dans aucun preset, ce qui est la definition du cas.
    await page.evaluate(() => {
      sessionStorage.setItem('bumpmesh-settings', JSON.stringify({
        activeMapName: 'ma-texture-a-moi-qui-nest-pas-un-preset.png',
      }));
    });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    // La selection initiale est asynchrone (chargement des vignettes) : on
    // attend l'etat, on ne dort pas un delai devine.
    await expect.poll(async () => page.evaluate(() =>
      document.querySelectorAll('.preset-swatch canvas').length), { timeout: 15000 })
      .toBeGreaterThan(5);

    const nom = await page.evaluate(() =>
      document.getElementById('active-map-name')?.textContent?.trim());

    // Le nom peut rester « aucune carte » (la custom n'existe pas vraiment dans
    // ce test) — ce qui compte est qu'aucun PRESET ne se soit impose de force.
    expect(nom, `le demarrage a impose un preset a la place de la carte personnalisee : "${nom}"`)
      .not.toBe('Crystal');

    const actif = await page.evaluate(() =>
      document.querySelectorAll('.preset-swatch.active').length);
    expect(actif, 'aucun preset ne doit etre marque actif quand la derniere carte etait personnalisee')
      .toBe(0);
  } finally {
    await page.evaluate(() => {
      sessionStorage.removeItem('bumpmesh-settings');
      window.bumpforgeElectron?.setDirty(false);
    }).catch(() => {});
    await app.close();
  }
});
