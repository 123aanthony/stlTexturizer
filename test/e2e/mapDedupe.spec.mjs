import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, statSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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


/**
 * Compte les slots DANS l'archive plutot que de le supposer.
 *
 * ⚠️ Le projet de reference est un fichier VIVANT que l'utilisateur
 * re-enregistre. Une premiere version attendait 18 slots et expirait sans un mot
 * le jour ou il n'en a garde que 13 — le test semblait denoncer le code alors
 * qu'il decrivait un fichier perime.
 */
function nbSlots(chemin) {
  const py = [
    'import zipfile,json,sys',
    'z=zipfile.ZipFile(sys.argv[1])',
    "print(len(json.loads(z.read('settings.json')).get('textureSlots') or []))",
  ].join(String.fromCharCode(10));
  return parseInt(execFileSync('py', ['-3', '-c', py, chemin], { encoding: 'utf8' }).trim(), 10);
}


/**
 * Images distinctes vs nombre de payloads REELLEMENT ecrits dans l'archive.
 *
 * ⚠️ On compte des OCCURRENCES, pas des valeurs distinctes. Une premiere version
 * hachait les payloads et comptait l'ensemble obtenu : elle dedupliquait donc
 * elle-meme, rendait « 3 copies » que la deduplication soit active ou non, et
 * passait au VERT sur du code neutralise. Un oracle qui deduplique ne peut pas
 * mesurer une duplication.
 */
function comptesDeCartes(chemin) {
  const py = [
    'import zipfile,json,sys,hashlib',
    'z=zipfile.ZipFile(sys.argv[1])',
    "d=json.loads(z.read('settings.json'))",
    "sl=d.get('textureSlots') or []",
    "noms={s.get('customMapName') for s in sl if s.get('customMapName')}",
    "lib=d.get('mapLibrary') or {}",
    "inline=sum(1 for s in sl if s.get('customMapDataUrl'))",
    "copies=len(lib) + inline",
    "print(len(noms), copies)",
  ].join(String.fromCharCode(10));
  const out = execFileSync('py', ['-3', '-c', py, chemin], { encoding: 'utf8' }).trim();
  const [noms, copies] = out.split(/[ ]+/).map(Number);
  return { noms, copies };
}

test.describe('deduplication des cartes du projet', () => {
  test('aller-retour fidele, et une seule copie par image', async () => {
    test.skip(!existsSync(SOURCE), `projet de reference absent : ${SOURCE}`);
    test.setTimeout(400_000);

    try { rmSync(CIBLE, { force: true }); } catch { /* pas encore la */ }

    const slots = nbSlots(SOURCE);
    console.log(`
  projet de reference : ${slots} slots`);

    const { app, page } = await launchApp(appRoot);
    try {
      // La boite de dialogue d'enregistrement est remplacee par un chemin fixe :
      // on veut exercer le VRAI chemin d'ecriture, pas le contourner.
      await app.evaluate(async ({ dialog }, chemin) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: chemin });
      }, CIBLE);

      await page.setInputFiles('#import-project-input', SOURCE);
      await page.waitForFunction(
        (n) => document.querySelectorAll('.texture-tab[data-slot]').length === n,
        slots, { timeout: 180_000 });
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

      // ⚠️ ON MESURE LA DUPLICATION, PAS UN RAPPORT DE TAILLES. Un seuil du type
      // « moins de 60 % de la source » supposait une source NON dedupliquee : le
      // jour ou le fichier de reference est lui-meme au nouveau format, il ne
      // reste rien a gagner et le test accuse le code a tort. Le nombre de copies
      // exprime l'invariant directement, quel que soit le format de depart.
      const compte = comptesDeCartes(CIBLE);
      console.log(`  cartes : ${compte.noms} distincte(s), ${compte.copies} copie(s) stockee(s)`);
      expect(compte.noms, 'aucune carte dans le fichier ecrit : le test ne prouverait rien')
        .toBeGreaterThan(0);
      expect(compte.copies,
        'une image est stockee plusieurs fois : la deduplication n a pas eu lieu')
        .toBe(compte.noms);

      // Aller-retour : on rouvre le fichier ecrit et on recompare slot par slot.
      await page.setInputFiles('#import-project-input', CIBLE);
      await page.waitForFunction(
        (n) => document.querySelectorAll('.texture-tab[data-slot]').length === n,
        slots, { timeout: 180_000 });
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
      console.log(`  aller-retour : les ${slots} slots retrouvent leur carte`);
    } finally {
      await page.evaluate(() => window.bumpforgeElectron?.setDirty(false)).catch(() => {});
      await app.close();
      try { rmSync(CIBLE, { force: true }); } catch { /* deja parti */ }
    }
  });
});
