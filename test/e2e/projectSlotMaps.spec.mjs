import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { launchApp } from './launch.mjs';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Ouvrir un projet doit rendre a CHAQUE slot sa carte ET ses dimensions.
//
// LE DEFAUT, mesure par instrumentation sur le projet reel de l'utilisateur
// --------------------------------------------------------------------------
// `setInterval(refreshExportAllSlotsButton, 500)` (main.js) appelle
// `saveActiveSlotState()` deux fois par seconde, sans jamais s'arreter. Cette
// fonction recopie l'etat de MODULE dans le slot ACTIF :
//     slot.activeMapEntry = activeMapEntry;                       // la carte
//     slot.settings = stripGlobalExportQualitySettings(...);      // les cotes
//
// Au demarrage, `activeTextureSlotId` vaut 'slot1' et la ligne qui le remplace
// par le slot sauvegarde n'arrive qu'APRES la boucle de restauration — laquelle
// `await` un decodage d'image par slot personnalise. Le minuteur tombe donc en
// plein milieu et reecrit le preset de repli et les reglages du snapshot GLOBAL
// par-dessus le slot 1 tout juste restaure.
//
// Trace obtenue en instrumentant l'ecriture :
//     [1] slot1 <- null                              (boucle : remise a zero)
//     [2] slot1 <- Crystal                           (minuteur)
//     [3] slot1 <- japanese_stone_wall_disp_4k.png   (boucle : CORRECT)
//     [4..7] slot1 <- Crystal                        (minuteur, 4 fois)
//
// Seul le slot 1 est touche : c'est le slot actif au DEMARRAGE, donc le seul
// que le minuteur puisse atteindre pendant la fenetre de restauration. Les 21
// autres passent — ce qui rendait le defaut deroutant.
//
// ⚠️ PORTEE. Ce test lit un projet qui n'est PAS dans le depot ; il se skip
// proprement s'il manque, et un skip n'est pas un succes. L'invariant de
// cablage est tenu sans fichier externe par test/bootFallback.mjs.
const PROJET = join(homedir(), 'Downloads', 'house-repare.bforge');

// Ce que le FICHIER contient, releve par lecture directe de l'archive.
const ATTENDU = {
  slot1:  { carte: 'japanese_stone_wall', echelle: 30.7 },
  slot18: { carte: 'ChatGPT Image 22',    echelle: 51.7 },
  slot22: { carte: 'ChatGPT Image 22',    echelle: 43.8 },
};

test('chaque slot retrouve SA carte et SES cotes a l\'ouverture', async () => {
  test.skip(!existsSync(PROJET), `projet de reference absent : ${PROJET}`);
  test.setTimeout(180_000);

  const { app, page } = await launchApp(appRoot);
  try {
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(e.message));

    await page.setInputFiles('#import-project-input', PROJET);

    // On attend l'ETAT, jamais un delai devine. Le bouton d'ajout de slot porte
    // lui aussi la classe .texture-tab : on ne compte que ceux qui designent
    // un slot.
    await expect.poll(async () => page.evaluate(() =>
      document.querySelectorAll('.texture-tab[data-slot]').length),
      { message: 'le projet n\'a pas fini de se restaurer', timeout: 90_000 })
      .toBe(22);

    // Relecture slot par slot : on clique l'onglet et on lit ce qui s'affiche.
    // C'est le geste exact de l'utilisateur, donc exactement ce qu'il voit.
    const lu = await page.evaluate(async () => {
      const out = {};
      const attendre = () => new Promise(r => setTimeout(r, 120));
      const tabs = [...document.querySelectorAll('.texture-tab[data-slot]')];
      for (const btn of tabs) {
        btn.click();
        await attendre();
        out[btn.dataset.slot] = {
          carte: (document.getElementById('active-map-name')?.textContent || '').trim(),
          echelle: Number(document.getElementById('scale-u-val')?.value),
        };
      }
      // ⚠️ DISAMBIGUATION. slot1 est lu EN PREMIER : son libelle pourrait
      // n'etre que la valeur du demarrage restee affichee faute de
      // rafraichissement — un defaut d'AFFICHAGE, pas de restauration. On
      // repasse par un autre slot puis on relit.
      const t1 = tabs.find(t => t.dataset.slot === 'slot1');
      const t5 = tabs.find(t => t.dataset.slot === 'slot5');
      if (t1 && t5) {
        t5.click(); await attendre();
        t1.click(); await attendre();
        out.__relu = {
          carte: (document.getElementById('active-map-name')?.textContent || '').trim(),
          echelle: Number(document.getElementById('scale-u-val')?.value),
        };
      }
      return out;
    });

    const relu = lu.__relu; delete lu.__relu;

    console.log('\n  Etat lu dans chaque slot :');
    for (const [id, v] of Object.entries(lu)) {
      console.log(`    ${id.padEnd(7)} ${String(v.echelle).padStart(6)} mm   ${v.carte}`);
    }
    console.log(`\n  slot1 lu en PREMIER : "${lu.slot1.carte}" / ${lu.slot1.echelle} mm`);
    console.log(`  slot1 RELU apres detour : "${relu.carte}" / ${relu.echelle} mm`);
    // Les deux lectures ne DIAGNOSTIQUENT que si la valeur est fausse ; si elle
    // est bonne, elles disent seulement que l'affichage est stable. Un message
    // qui conclurait « l'etat est faux » dans les deux cas serait un oracle
    // menteur.
    console.log(lu.slot1.carte === relu.carte
      ? '  -> les deux lectures concordent (affichage stable)'
      : '  -> elles DIVERGENT : defaut d\'AFFICHAGE, pas de restauration');

    // Le projet ne contient AUCUN preset : toute occurrence est une ecriture
    // parasite, quel que soit le slot.
    const pollues = Object.entries(lu).filter(([, v]) => v.carte === 'Crystal');
    expect(pollues.map(([id]) => id),
      'des slots portent le preset de repli alors que le projet n\'en contient aucun')
      .toEqual([]);

    for (const [id, att] of Object.entries(ATTENDU)) {
      expect(lu[id].carte, `${id} : carte inattendue`).toContain(att.carte);
      // Les cotes sont l'AUTRE moitie du defaut : la meme fonction ecrit
      // slot.settings depuis le snapshot global. Les verifier separement evite
      // de declarer le defaut clos sur la seule carte.
      expect(lu[id].echelle, `${id} : cote inattendue`).toBeCloseTo(att.echelle, 1);
    }

    expect(erreurs, `erreurs pendant l'ouverture :\n${erreurs.join('\n')}`).toEqual([]);
  } finally {
    await page.evaluate(() => window.bumpforgeElectron?.setDirty(false)).catch(() => {});
    await app.close();
  }
});
