import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { launchApp } from './launch.mjs';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = join(homedir(), 'Downloads', 'house-mod.bforge');
const AVEC = join(tmpdir(), 'bumpforge-solides.bforge');

// L'identite EXACTE des pieces doit survivre a la reouverture d'un projet.
//
// LE DEFAUT. `_stepSolidOfFace` n'etait renseigne qu'au chargement d'un STEP.
// Rouvrir un `.bforge` restaurait bien le sidecar (`currentFaceSidecar`) mais
// jamais l'identite des solides : la detection retombait EN SILENCE sur les
// composantes connexes, un repli heuristique.
//
// Ce que cela coute, mesure sur le modele reel : 462 composantes connexes, dont
// 128 d'UN SEUL triangle et 150 sous les dix — ce ne sont pas des pieces, ce
// sont des fragments de maillage. Sur le slot d'une porte, 399 triangles ne
// formaient que 7 « pieces » pour une dizaine de planches visibles.
//
// ⚠️ Le test FABRIQUE un projet dont le sidecar porte des `solid`, celui de
// l'utilisateur ayant ete ecrit avant que ce champ existe. Les DEUX chemins sont
// verifies : avec solides -> compte exact ; sans -> repli annonce comme tel.
// Sans le second volet, un message code en dur passerait le premier.

const NB_SOLIDES = 11;

/** Compte les slots DANS l'archive plutot que de le supposer. */
function nbSlots(chemin) {
  const py = [
    'import zipfile,json,sys',
    'z=zipfile.ZipFile(sys.argv[1])',
    "print(len(json.loads(z.read('settings.json')).get('textureSlots') or []))",
  ].join('\n');
  return parseInt(execFileSync('py', ['-3', '-c', py, chemin], { encoding: 'utf8' }).trim(), 10);
}

/** Copie le projet en dotant chaque face d'un identifiant de solide. */
function fabriquer() {
  const py = [
    'import zipfile, json, sys',
    'src, dst, n = sys.argv[1], sys.argv[2], int(sys.argv[3])',
    'z = zipfile.ZipFile(src)',
    "fj = json.loads(z.read('faces.json'))",
    "faces = fj['faces']",
    'par = max(1, (len(faces) + n - 1) // n)',
    'for i, f in enumerate(faces):',
    "    f['solid'] = i // par",
    "with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as out:",
    '    for info in z.infolist():',
    '        data = z.read(info.filename)',
    "        if info.filename == 'faces.json':",
    '            data = json.dumps(fj, ensure_ascii=False).encode()',
    '        out.writestr(info, data)',
    "print(len(set(f['solid'] for f in faces)))",
  ].join('\n');
  const out = execFileSync('py', ['-3', '-c', py, SOURCE, AVEC, String(NB_SOLIDES)],
    { encoding: 'utf8' });
  return parseInt(out.trim(), 10);
}

test.describe('identite des pieces a la reouverture', () => {
  test('les solides du sidecar sont repris, sinon le repli est annonce', async () => {
    test.skip(!existsSync(SOURCE), `projet de reference absent : ${SOURCE}`);
    test.setTimeout(400_000);

    try { rmSync(AVEC, { force: true }); } catch { /* pas encore la */ }
    const solides = fabriquer();
    expect(solides, 'la fabrication du projet de test a echoue').toBe(NB_SOLIDES);

    // ⚠️ LU dans l'archive, jamais code en dur : le projet de reference est un
    // fichier VIVANT que l'utilisateur re-enregistre. Une premiere version
    // attendait 18 slots et expirait sans un mot le jour ou il n'en a garde que
    // 13 — le test semblait denoncer le code alors qu'il decrivait un fichier
    // perime.
    const slots = nbSlots(SOURCE);
    console.log(`\n  projet : ${slots} slots | sidecar fabrique a ${solides} solides`);

    const { app, page } = await launchApp(appRoot);
    try {
      const charger = async (chemin) => {
        await page.setInputFiles('#import-project-input', chemin);
        await page.waitForFunction(
          (n) => document.querySelectorAll('.texture-tab[data-slot]').length === n,
          slots, { timeout: 180_000 });
        await page.waitForTimeout(5000);
        // ⚠️ `refreshPieceInfo` VIDE le message quand la variation par piece est
        // neutre — c'est voulu, un compte de pieces n'interesse personne tant
        // que le reglage ne fait rien. Le test doit donc l'activer, sinon il lit
        // une chaine vide et croit a un defaut.
        return page.evaluate(() => {
          const c = document.getElementById('piece-flip');
          if (c && !c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }
          return (document.getElementById('piece-info')?.textContent || '').trim();
        });
      };

      const avec = await charger(AVEC);
      console.log(`  avec solides : "${avec}"`);
      expect(avec, 'le compte de pieces ne vient pas des solides du STEP').toMatch(/STEP/i);
      expect(avec, `le compte devrait valoir ${NB_SOLIDES}`).toContain(String(NB_SOLIDES));

      const sans = await charger(SOURCE);
      console.log(`  sans solides : "${sans}"`);
      expect(sans, 'le repli ne devrait PAS se presenter comme exact').not.toMatch(/STEP/i);
      expect(sans, 'le repli devrait annoncer des composantes connexes').toMatch(/\d/);
    } finally {
      await page.evaluate(() => window.bumpforgeElectron?.setDirty(false)).catch(() => {});
      await app.close();
      try { rmSync(AVEC, { force: true }); } catch { /* deja parti */ }
    }
  });
});
