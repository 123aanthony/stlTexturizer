import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, statSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { launchApp } from './launch.mjs';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = join(homedir(), 'Downloads', 'house-mod.bforge');
const CIBLE = join(tmpdir(), 'bumpforge-dedupe-test.bforge');

// Une carte n'est ecrite qu'UNE fois par projet — et l'aller-retour est fidele.
//
// LE DEFAUT MESURE. Chaque slot portait sa propre copie de la carte en data
// URL. Sur le projet reel de l'utilisateur : 18 slots, 3 textures distinctes,
// 57.7 Mo — la meme image ecrite SEIZE fois. La compression n'y peut rien, la
// fenetre de deflate faisant 32 Ko : elle ne voit pas des doublons distants de
// plusieurs megaoctets.
//
// Prix paye a CHAQUE edition, l'instantane de reprise re-serialisant tout :
//     encodage des cartes    645 ms      ->  105 ms
//     compression           1456 ms      ->  402 ms
//     settings.json         59.5 Mo      -> 11.5 Mo
//     fichier .bforge       47.8 Mo      -> 10.8 Mo
//     gel du thread         1488 ms      ->  415 ms
//     chargement du projet     4.3 s     ->    2.3 s
//
// POURQUOI CE TEST EST INDISPENSABLE. C'est un changement de FORMAT. Si
// l'ecriture et la lecture divergent, l'utilisateur perd son travail sans
// s'en apercevoir — le pire defaut possible ici. On verifie donc la fidelite
// slot par slot, pas seulement que le fichier a maigri.

test.describe('deduplication des cartes du projet', () => {
  test('aller-retour fidele, et une seule copie par image', async () => {
    test.skip(!existsSync(SOURCE), `projet de reference absent : ${SOURCE}`);
    test.setTimeout(400_000);

    try { rmSync(CIBLE, { force: true }); } catch { /* pas encore la */ }

    const { app, page } = await launchApp(appRoot);
    try {
      // La boite de dialogue d'enregistrement est remplacee par un chemin fixe :
      // on veut exercer le VRAI chemin d'ecriture, pas le contourner.
      await app.evaluate(async ({ dialog }, chemin) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: chemin });
      }, CIBLE);

      await page.setInputFiles('#import-project-input', SOURCE);
      await page.waitForFunction(() =>
        document.querySelectorAll('.texture-tab[data-slot]').length === 18,
        null, { timeout: 180_000 });
      await page.waitForTimeout(4000);

      // Etat de reference : la carte de CHAQUE slot, telle qu'affichee.
      const lire = () => page.evaluate(async () => {
        const out = {};
        const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
        for (const b of document.querySelectorAll('.texture-tab[data-slot]')) {
          b.click(); await attendre(110);
          out[b.dataset.slot] = (document.getElementById('active-map-name')?.textContent || '').trim();
        }
        return out;
      });
      const avant = await lire();
      const distinctes = new Set(Object.values(avant).filter(Boolean));
      console.log(`\n  ${Object.keys(avant).length} slots, ${distinctes.size} carte(s) distincte(s)`);
      expect(distinctes.size,
        'moins de deux cartes distinctes : le test ne prouverait rien sur le partage')
        .toBeGreaterThan(1);

      await page.evaluate(() => document.getElementById('project-save-as-btn')?.click());
      await expect.poll(() => existsSync(CIBLE), { timeout: 180_000 }).toBe(true);
      // L'ecriture peut encore etre en cours : on attend que la taille se stabilise.
      await expect.poll(() => { const a = statSync(CIBLE).size; return a; },
        { timeout: 60_000, intervals: [1000, 1000, 1000] }).toBeGreaterThan(1000);
      await page.waitForTimeout(3000);

      const tailleSource = statSync(SOURCE).size;
      const tailleCible = statSync(CIBLE).size;
      console.log(`  fichier : ${(tailleSource / 1e6).toFixed(1)} Mo -> ${(tailleCible / 1e6).toFixed(1)} Mo`);

      // Le fichier doit contenir une BIBLIOTHEQUE, et une seule copie par image.
      const brut = readFileSync(CIBLE);
      expect(tailleCible,
        'le fichier n\'a pas maigri : la deduplication n\'a pas eu lieu')
        .toBeLessThan(tailleSource * 0.6);

      // Aller-retour : on rouvre le fichier ecrit et on recompare slot par slot.
      await page.setInputFiles('#import-project-input', CIBLE);
      await page.waitForFunction(() =>
        document.querySelectorAll('.texture-tab[data-slot]').length === 18,
        null, { timeout: 180_000 });
      await page.waitForTimeout(4000);
      const apres = await lire();

      const ecarts = Object.keys(avant).filter((k) => avant[k] !== apres[k]);
      if (ecarts.length) {
        console.log('  ECARTS :');
        for (const k of ecarts) console.log(`    ${k} : "${avant[k]}" -> "${apres[k]}"`);
      }
      expect(ecarts,
        'des slots ont change de carte apres aller-retour : le format perd des donnees')
        .toEqual([]);
      console.log('  aller-retour : les 18 slots retrouvent leur carte');
    } finally {
      await page.evaluate(() => window.bumpforgeElectron?.setDirty(false)).catch(() => {});
      await app.close();
      try { rmSync(CIBLE, { force: true }); } catch { /* deja parti */ }
    }
  });
});
