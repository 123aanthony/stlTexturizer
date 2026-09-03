import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { launchApp } from './launch.mjs';

// BIBLIOTHEQUE DE MATIERES PAR COULEUR — chaine complete, vraie app.
//
// CE QUE CE FICHIER COUVRE, ET QUE RIEN D'AUTRE NE PEUT COUVRIR
// ------------------------------------------------------------
// `test/materialLibrary.mjs` prouve la DECISION (quelle matiere pour quelle
// couleur) : elle est pure, elle se teste hors DOM. Il y ajoute six controles de
// CABLAGE qui LISENT le source de main.js — utiles, parce que les defauts qu'ils
// attrapent sont muets, mais ce ne sont pas des oracles de COMPORTEMENT : ils
// verifient que la ligne est ecrite, pas qu'elle produit le bon effet.
//
// Le trajet reel, lui, traverse l'import STEP, meshStep, les auto-slots, le DOM
// des onglets, la resolution d'une entree de carte, IndexedDB et la FERMETURE de
// l'application. Aucun de ces maillons n'existe en headless.
//
// ⚠️ ET LE MAILLON DECISIF EST LA FERMETURE. Toute la promesse tient en une
// phrase : « la matiere reglee une fois revient sur le batiment suivant ». Un
// test qui memoriserait et relirait DANS LA MEME SESSION serait vert meme si
// rien n'etait jamais ecrit sur le disque — le cache memoire (`_materialLibrary`)
// suffirait a le satisfaire. On QUITTE donc l'app entre les deux phases, en
// relancant sur le MEME profil : c'est le seul montage ou l'echec d'ecriture
// IndexedDB se voit.
//
// SCENARIO
//   Phase 1 — STEP colore (5 couleurs FW reelles) sur une ardoise vierge :
//             auto-slots, on renomme le premier, on lui donne une carte et une
//             amplitude reconnaissables, on memorise, on QUITTE.
//   Phase 2 — meme profil, app relancee, MEME STEP : le slot doit revenir avec
//             son nom, sa carte et son amplitude.
//
// La fixture est un VRAI export GUI FreeCAD (`interop_colored.step`, chaine FW,
// 5 COLOUR_RGB distincts) : le headless ne peut pas en produire (pas de
// ViewObject), et c'est justement le fichier que le flux vise.

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = join(appRoot, 'test', 'fixtures', 'freecad');
const TMP = join(appRoot, 'test', 'e2e', '.tmp-matlib');

// Marqueurs volontairement improbables : s'ils reviennent, ils ne peuvent pas
// venir d'un defaut de l'app.
const NOM_MARQUEUR = 'Pierre marqueur';
const PRESET = 'Brick';
const AMPLITUDE = '0.37';

// Les toasts suivent la langue du systeme : on accepte les deux.
//
// ⚠️ `T_RECONNUES` doit nommer la MATIERE, pas se contenter de « reconnue ».
// Premiere version : /reconnue|recognized/ — elle attrapait « Modele FreeCAD :
// 308 faces RECONNUES », un toast qui n'a rien a voir et qui parait a CHAQUE
// chargement. Le cas positif serait donc passe au vert sans qu'aucune matiere
// ne soit appliquee, et c'est le cas NEGATIF qui l'a revele. Une sonde se
// verifie avant d'accuser le code.
const T_SLOTS      = /slots? (créés|created)/i;
const T_RECONNUES  = /(matière|material)\(s\) (reconnue|recognized)/i;
const T_MEMORISEES = /(mémorisée|remembered)/i;

const step = () => join(TMP, 'colored.step');

async function chargerStep(page) {
  await page.setInputFiles('#stl-file-input', step());
  await expect(page.locator('.toast', { hasText: /faces reconnues|faces recognized/i }))
    .toBeVisible({ timeout: 30_000 });
}

/** Libelle de l'onglet de slot d'indice i. */
const labelOnglet = (page, i) =>
  page.locator('.texture-tab .texture-tab-label').nth(i);

test('une matiere memorisee pour sa couleur revient apres fermeture de l app', async () => {
  // ⚠️ Large a dessein : ce delai garde contre un BLOCAGE, il ne mesure pas la
  // vitesse. MESURE le 03/09 : le meme test passe en 14 s sur une machine au
  // repos et en 44 s la meme journee sous charge — a 180 s il tombait alors en
  // expiration, et un test qui depend de l'humeur de la machine finit ignore.
  // Ce cas lance Electron DEUX fois et charge le STEP deux fois : sous charge il
  // a ete mesure a plus de 6 minutes, la ou il en met 14 secondes a vide.
  test.setTimeout(600_000);

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  copyFileSync(join(FIX, 'interop_colored.step'), step());

  let profil = null;

  // ── PHASE 1 : regler puis memoriser ────────────────────────────────────────
  {
    const { app, page, userData } = await launchApp(appRoot);
    profil = userData;
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await expect(page.locator('#viewport')).toBeAttached();
      await chargerStep(page);

      // Ardoise vierge + STEP colore => un slot par couleur. Le toast est celui
      // SANS matiere reconnue : la bibliotheque est vide, c'est le point de
      // depart et il doit se distinguer de l'arrivee.
      await expect(page.locator('.toast', { hasText: T_SLOTS })).toBeVisible({ timeout: 30_000 });
      const nbOnglets = await page.locator('.texture-tab').count();
      expect(nbOnglets, 'la fixture a 5 couleurs : il doit en sortir plusieurs slots')
        .toBeGreaterThan(1);

      // Le premier slot est actif apres les auto-slots (restoreSlotState).
      // On le renomme : sans ca l'assertion de nom ne discriminerait rien, le
      // nom d'origine etant deja celui que les auto-slots reposeraient.
      const label = labelOnglet(page, 0);
      await label.dblclick();
      const saisie = page.locator('.texture-tab-rename-input');
      await expect(saisie).toBeVisible();
      await saisie.fill(NOM_MARQUEUR);
      await saisie.press('Enter');
      await expect(labelOnglet(page, 0)).toHaveText(NOM_MARQUEUR);

      // Une carte et une amplitude reconnaissables.
      await page.locator(`.preset-swatch[title="${PRESET}"]`).click();
      await expect(page.locator('#active-map-name')).toHaveText(PRESET, { timeout: 20_000 });
      const amp = page.locator('#amplitude-val');
      await amp.fill(AMPLITUDE);
      await amp.press('Enter');
      await amp.blur();

      // ⚠️ Le slot ACTIF porte son etat dans les globales, pas dans ses champs
      // stockes : c'est `rememberSlotMaterials` qui doit appeler
      // saveActiveSlotState avant de lire. Si ce flush manquait, la matiere
      // memorisee serait l'ANCIENNE — et seul ce test le verrait.
      await page.locator('#remember-materials-btn').click();
      await expect(page.locator('.toast', { hasText: T_MEMORISEES }))
        .toBeVisible({ timeout: 15_000 });

      const fatal = errors.filter(e => !/favicon|DevTools/i.test(e));
      expect(fatal, `erreurs non rattrapees (phase 1) :\n${fatal.join('\n')}`).toEqual([]);
    } finally {
      // La fermeture EST le test : elle force l'ecriture a survivre au process.
      await app.close();
    }
  }

  // ── PHASE 2 : meme profil, app relancee, meme STEP ────────────────────────
  {
    const { app, page } = await launchApp(appRoot, { userData: profil });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await expect(page.locator('#viewport')).toBeAttached();
      await chargerStep(page);

      // Le toast DOIT annoncer des matieres reconnues : c'est lui qui distingue
      // "des slots ont ete crees" de "des slots ont ete crees ET habilles".
      await expect(page.locator('.toast', { hasText: T_RECONNUES }))
        .toBeVisible({ timeout: 30_000 });

      // 1. le NOM voyage avec la matiere (sinon le slot reprendrait celui de sa
      //    piece dominante, qui ne dit rien de la matiere)
      await expect(labelOnglet(page, 0)).toHaveText(NOM_MARQUEUR);

      // 2. la CARTE est revenue (le slot 0 est actif apres les auto-slots)
      await expect(page.locator('#active-map-name')).toHaveText(PRESET, { timeout: 20_000 });

      // 3. les REGLAGES aussi — une matiere, ce n'est pas qu'une image
      await expect(page.locator('#amplitude-val')).toHaveValue(AMPLITUDE);

      const fatal = errors.filter(e => !/favicon|DevTools/i.test(e));
      expect(fatal, `erreurs non rattrapees (phase 2) :\n${fatal.join('\n')}`).toEqual([]);
    } finally {
      await app.close();
      rmSync(TMP, { recursive: true, force: true });
    }
  }
});

test('un profil VIERGE ne reconnait rien (l oracle ne se contente pas d etre vert)', async () => {
  // ⚠️ Sans ce second cas, le premier passerait aussi bien si l'app annoncait
  // "matiere reconnue" a tort — par exemple en repeignant simplement le dernier
  // etat, ou si le toast d'arrivee etait devenu le toast par defaut. On verifie
  // donc que sur un profil NEUF le message est celui du depart, PAS celui de
  // l'arrivee : les deux chemins doivent rester distinguables.
  test.setTimeout(240_000);

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  copyFileSync(join(FIX, 'interop_colored.step'), step());

  const { app, page } = await launchApp(appRoot);   // profil neuf : rien en memoire
  try {
    await expect(page.locator('#viewport')).toBeAttached();
    await chargerStep(page);
    await expect(page.locator('.toast', { hasText: T_SLOTS })).toBeVisible({ timeout: 30_000 });

    const toasts = (await page.locator('.toast').allTextContents()).join(' | ');
    expect(toasts, `un profil vierge annonce des matieres reconnues :\n${toasts}`)
      .not.toMatch(T_RECONNUES);
  } finally {
    await app.close();
    rmSync(TMP, { recursive: true, force: true });
  }
});
