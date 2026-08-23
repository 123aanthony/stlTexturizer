import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { launchApp } from './launch.mjs';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJET = join(homedir(), 'Downloads', 'house-repare.bforge');

// Les vignettes d'onglet ne doivent pas etre RE-ENCODEES a chaque rafraichissement.
//
// LE DEFAUT MESURE
// ----------------
// La vignette de chaque onglet etait peinte par
//   thumb.style.backgroundImage = `url(${entry.fullCanvas.toDataURL('image/png')})`
// c'est-a-dire un encodage PNG COMPLET de la texture, par onglet, a chaque
// appel de refreshTextureTabsUI. Cette fonction est appelee par
// saveActiveSlotState, lui-meme appele par setInterval(..., 500) : sur un
// projet de 22 slots, 22 encodages PNG DEUX FOIS PAR SECONDE, pour peindre des
// vignettes de quelques dizaines de pixels.
//
// Mesure sur le projet reel (22 slots, cartes 512x512, 53 312 triangles), au
// repos, sans rien toucher :
//     p99 des images    232 ms   ->   5.6 ms
//     images en 6 s        733   ->    1443
//     taches longues        24   ->       0  (cumul 5.6 s sur 6 s)
// La charge CPU moyenne restait basse (un demi-coeur) : d'ou le « pourtant ma
// machine n'a pas l'air de souffrir ». Un a-coup periodique ne se voit pas sur
// une moyenne.
//
// POURQUOI CET ORACLE COMPTE LES ENCODAGES ET NE CHRONOMETRE PAS
// --------------------------------------------------------------
// Un seuil en millisecondes depend de la machine, de la charge, du GC : il
// serait instable, et un oracle instable finit par etre ignore. Le nombre
// d'appels a toDataURL, lui, est une propriete du CODE : il doit etre NUL une
// fois les vignettes calculees, quel que soit le materiel.

test.describe('vignettes des onglets de slot', () => {
  test('elles sont calculees une fois, pas a chaque rafraichissement', async () => {
    test.skip(!existsSync(PROJET), `projet de reference absent : ${PROJET}`);
    test.setTimeout(180_000);

    const { app, page } = await launchApp(appRoot);
    try {
      await page.setInputFiles('#import-project-input', PROJET);
      await page.waitForFunction(() =>
        document.querySelectorAll('.texture-tab[data-slot]').length === 22,
        null, { timeout: 90_000 });
      // Laisse passer les premiers tirs du minuteur : les vignettes se calculent
      // la, et c'est legitime. Ce qu'on traque, c'est la REPETITION.
      await page.waitForTimeout(2000);

      // 1. CORRECTION AVANT PERFORMANCE : une vignette memoisee qui n'affiche
      //    rien serait « rapide » et fausse. On verifie donc d'abord qu'elles
      //    sont bien peintes.
      const vignettes = await page.evaluate(() =>
        [...document.querySelectorAll('.texture-tab[data-slot]')].map((b) => ({
          slot: b.dataset.slot,
          fond: (b.querySelector('.texture-tab-thumb')?.style.backgroundImage || '').slice(0, 22),
        })));
      // Le navigateur NORMALISE en url("data:...") avec guillemets : un
      // startsWith sans eux echoue sur une vignette parfaitement peinte.
      const peintes = vignettes.filter((v) => /^url\(["']?data:image/.test(v.fond));
      console.log(`\n  vignettes peintes : ${peintes.length}/${vignettes.length}`);
      expect(peintes.length,
        'aucune vignette peinte : la memoisation a casse l\'affichage')
        .toBeGreaterThan(15);

      // 2. Compteur d'encodages. On l'installe APRES la phase de calcul.
      await page.evaluate(() => {
        window.__enc = 0;
        const vrai = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function (...a) {
          window.__enc++;
          return vrai.apply(this, a);
        };
      });

      // ~6 tirs du minuteur de 500 ms, plus quelques changements de slot :
      // autant d'occasions de re-encoder si la memoisation ne tient pas.
      await page.evaluate(async () => {
        const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
        const tabs = [...document.querySelectorAll('.texture-tab[data-slot]')];
        for (const t of tabs.slice(0, 6)) { t.click(); await attendre(120); }
        await attendre(3000);
      });

      const enc = await page.evaluate(() => window.__enc);
      console.log(`  encodages PNG pendant 3 s + 6 changements de slot : ${enc}`);
      expect(enc,
        'les vignettes sont re-encodees : sur un gros projet cela bloque le '
        + 'thread principal deux fois par seconde')
        .toBe(0);
    } finally {
      await page.evaluate(() => window.bumpforgeElectron?.setDirty(false)).catch(() => {});
      await app.close();
    }
  });
});
