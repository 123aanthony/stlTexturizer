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
  // `bootErrors` vient de launchApp, qui attache ses ecouteurs AVANT tout delai :
  // une erreur d'evaluation de module arrive a la milliseconde zero.
  const { app, page, bootErrors: errors } = await launchApp(appRoot);
  try {
    let crashed = false;
    page.on('crash', () => { crashed = true; });

    await expect(page).toHaveTitle(/bump|stl/i);

    // The viewer canvas (#viewport) is static in index.html but the WebGL
    // context is created by main.js initViewer(); if that throws or the GPU is
    // unavailable the renderer dies and this won't resolve.
    await expect(page.locator('#viewport')).toBeAttached();

    // PREUVE POSITIVE que main.js s'est reellement execute jusqu'au bout.
    // `#viewport` est STATIQUE dans index.html : sa presence ne prouve rien. La
    // grille de textures, elle, est construite par le code de main.js — si le
    // module a explose a l'evaluation, elle reste vide. Un import en double a
    // deja fait passer ce test au vert sur une app entierement morte.
    const swatches = await page.evaluate(() =>
      document.querySelectorAll('.preset-swatch').length);
    expect(swatches, "la grille de textures est vide : main.js n'a pas fini de s'evaluer").toBeGreaterThan(5);

    expect(crashed, 'renderer crashed during boot (WebGL/GPU unavailable?)').toBe(false);
    expect(errors, `uncaught errors during boot:\n${errors.join('\n')}`).toEqual([]);
  } finally {
    await app.close();
  }
});

// Le prefiltre d'antialiasing (js/mipPyramid.js) et le bouton Auto du lissage ne
// sont pilotables que si leurs controles existent VRAIMENT et portent les id que
// main.js interroge. Un id mal orthographie ne leve rien : `getElementById` rend
// null, l'`?.` l'avale, et le reglage devient simplement inatteignable depuis
// l'UI. Aucun test headless ne peut voir ce trou, main.js n'etant pas importable
// — d'ou ce garde-fou ici.
//
// PORTEE ASSUMEE : cablage et comportement de bout en bout du bouton. Les
// FORMULES (sigma recommande, empreinte, invariant anti-double-filtrage sur 60
// configurations) sont couvertes bien plus finement en headless par
// test/mipPyramid.mjs ; ici on prouve seulement que l'UI est branchee dessus.
//
// Deux pieges de ce harnais, payes en debug :
//   - L'etat se lit par `evaluate`, pas par les matchers d'actionnabilite de
//     Playwright : ceux-ci expirent sur ce panneau lateral scrollable alors que
//     les controles sont parfaitement visibles (mesure : case 13x13 px,
//     `visibility: visible`). Ils mesureraient la mise en page, pas le cablage.
//   - Toute mutation d'etat marque le projet SALE (`set-dirty` via preload), et
//     la garde de fermeture d'electron-main.js ouvre alors une boite
//     « modifications non enregistrees » que rien ne clique : `app.close()` ne
//     rend jamais la main et le vrai echec est masque par un timeout de
//     teardown. On rend donc le projet propre AVANT de fermer. C'est pour cette
//     raison que le smoke ci-dessus ne mute rien.
test('les controles d\'antialiasing sont cables au moteur', async () => {
  const { app, page } = await launchApp(appRoot);
  try {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    const state = await page.evaluate(() => {
      const box = document.getElementById('texture-antialias');
      const btn = document.getElementById('smoothing-auto-btn');
      const info = document.getElementById('smoothing-auto-info');
      return {
        boxPresent: !!box,
        boxChecked: box ? box.checked : null,
        boxVisible: box ? box.getBoundingClientRect().width > 0 : false,
        btnPresent: !!btn,
        btnVisible: btn ? btn.getBoundingClientRect().width > 0 : false,
        infoHidden: info ? info.classList.contains('hidden') : null,
      };
    });

    expect(state.boxPresent, 'case #texture-antialias absente du DOM').toBe(true);
    expect(state.boxVisible, 'case presente mais invisible').toBe(true);
    // Actif par defaut : c'est une correction d'echantillonnage, pas un effet.
    expect(state.boxChecked, 'le prefiltre doit etre actif par defaut').toBe(true);
    expect(state.btnPresent, 'bouton #smoothing-auto-btn absent').toBe(true);
    expect(state.btnVisible, 'bouton present mais invisible').toBe(true);
    expect(state.infoHidden, 'la ligne de diagnostic doit demarrer masquee').toBe(true);

    // Auto, avec le prefiltre ACTIF (l'etat par defaut). Une texture preset est
    // deja chargee au boot, donc le bouton a de quoi mesurer.
    const auto = await page.evaluate(() => {
      document.getElementById('smoothing-auto-btn').click();
      return {
        infoHidden: document.getElementById('smoothing-auto-info').classList.contains('hidden'),
        infoText:   document.getElementById('smoothing-auto-info').textContent,
        smoothing:  Number(document.getElementById('texture-smoothing-val').value),
      };
    });

    expect(auto.infoHidden, 'Auto doit publier son diagnostic').toBe(false);
    // Le chiffre qui explique tout — combien de pixels de texture chaque arete
    // de maille parcourt — n'etait visible NULLE PART avant ce bouton.
    expect(auto.infoText, `diagnostic sans mesure : "${auto.infoText}"`).toMatch(/[\d.]+\s*px/);
    // INVARIANT ANTI-DOUBLE-FILTRAGE, verifie sur l'app reelle : flou global et
    // prefiltre par sommet repondent a la meme contrainte de Nyquist, donc tant
    // que le prefiltre est actif l'Auto ne doit RIEN empiler par-dessus.
    expect(auto.smoothing, 'Auto a empile un flou par-dessus le prefiltre').toBe(0);

    expect(errors, `erreurs pendant le pilotage:\n${errors.join('\n')}`).toEqual([]);
  } finally {
    // Voir l'en-tete : sans ca, la garde de fermeture pend sur sa boite de
    // dialogue et masque le vrai resultat du test.
    await page.evaluate(() => window.bumpforgeElectron?.setDirty(false)).catch(() => {});
    await app.close();
  }
});

// Les reglages de preparation se calibrent sur le CONTENU d'une carte : un
// point noir a 0.2 creuse les joints d'un mur mais mange la moitie d'une
// texture de bois. Les trainer d'une carte a la suivante fait porter a la
// nouvelle des reglages tailles pour l'ancienne — ce que l'utilisateur lit
// comme un bug du chargement. On verifie donc qu'un choix de carte les remet
// a neutre.
//
// ⚠️ Ce test ne peut PAS vivre en headless : `resetMapAdjustments` est dans
// main.js, non importable, et c'est le CABLAGE (choix de carte -> reset) qu'on
// veut prouver, pas la fonction. Le partage global/par-slot, lui, est teste
// finement dans test/slotState.mjs.
test('choisir une carte remet la preparation a neutre', async () => {
  const { app, page } = await launchApp(appRoot);
  try {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const IDS = ['map-macro', 'map-micro', 'map-split', 'map-black', 'map-white', 'map-gamma'];
    const read = () => page.evaluate((ids) =>
      Object.fromEntries(ids.map(id => [id, Number(document.getElementById(id + '-val').value)])), IDS);

    const neutral = await read();
    expect(neutral, 'valeurs neutres au demarrage').toEqual({
      'map-macro': 1, 'map-micro': 1, 'map-split': 1,
      'map-black': 0, 'map-white': 1, 'map-gamma': 1,
    });

    // Deregler franchement, par l'evenement que le reste de l'app ecoute.
    await page.evaluate(() => {
      const set = (id, v) => {
        const el = document.getElementById(id + '-val');
        el.value = String(v);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('map-macro', 1.5); set('map-micro', 0.15); set('map-split', 2.5);
      set('map-black', 0.2); set('map-white', 0.8); set('map-gamma', 1.6);
    });
    const tweaked = await read();
    expect(tweaked['map-micro'], 'le dereglage n\'a pas pris').toBe(0.15);
    expect(tweaked['map-black']).toBe(0.2);

    // Choisir une carte : c'est le geste qui doit remettre a neutre.
    await page.evaluate(() => document.querySelector('.preset-swatch')?.click());

    // selectPreset est asynchrone (chargement de la texture) : on attend l'etat,
    // on ne dort pas un delai devine.
    await expect.poll(async () => (await read())['map-micro'], {
      message: 'la preparation n\'a pas ete remise a neutre',
      timeout: 15000,
    }).toBe(1);

    const after = await read();
    expect(after, 'tous les reglages doivent etre revenus a neutre').toEqual(neutral);

    expect(errors, `erreurs pendant le test:\n${errors.join('\n')}`).toEqual([]);
  } finally {
    // Choisir une carte salit le projet : sans ca, la garde de fermeture ouvre
    // sa boite de dialogue et `app.close()` ne rend jamais la main.
    await page.evaluate(() => window.bumpforgeElectron?.setDirty(false)).catch(() => {});
    await app.close();
  }
});

// Le reglage de largeur de couture (js/seamBlend.js) n'est pilotable que si son
// controle existe VRAIMENT et porte l'id que main.js interroge. Un id mal
// orthographie ne leve rien : getElementById rend null, l'optionnel l'avale, et
// le reglage devient simplement inatteignable depuis l'interface — defaut
// qu'aucun test headless ne peut voir, main.js n'etant pas importable.
//
// PORTEE : cablage seulement. Le COMPORTEMENT (largeur reellement atteinte,
// independance a la resolution, non-regression a 0) est couvert bien plus
// finement en headless par test/seamBlend.mjs.
test('le reglage de largeur de couture est cable', async () => {
  const { app, page } = await launchApp(appRoot);
  try {
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(e.message));

    const etat = await page.evaluate(() => {
      const sl = document.getElementById('seam-width');
      const va = document.getElementById('seam-width-val');
      if (!sl || !va) return { present: false };
      const avant = Number(va.value);
      // On pilote par l'evenement que le reste de l'app ecoute, pas par une
      // affectation directe : c'est le cablage qu'on veut prouver.
      sl.value = '3.5';
      sl.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        present: true,
        visible: sl.getBoundingClientRect().width > 0,
        avant,
        apres: Number(va.value),
      };
    });

    // Meme controle pour le seuil de taille de piece : deux reglages ajoutes le
    // meme jour, deux occasions d'un id mal orthographie.
    const seuil = await page.evaluate(() => {
      const sl = document.getElementById('piece-min-size');
      const va = document.getElementById('piece-min-size-val');
      if (!sl || !va) return { present: false };
      const avant = Number(va.value);
      sl.value = '6.5';
      sl.dispatchEvent(new Event('input', { bubbles: true }));
      return { present: true, visible: sl.getBoundingClientRect().width > 0,
               avant, apres: Number(va.value) };
    });
    expect(seuil.present, 'controle #piece-min-size absent du DOM').toBe(true);
    expect(seuil.visible, 'controle present mais invisible').toBe(true);
    expect(seuil.avant, 'le seuil doit demarrer a 0 (aucune piece ecartee)').toBe(0);
    expect(seuil.apres, "le champ ne suit pas le curseur : linkSlider n'est pas branche").toBe(6.5);

    // Le bouton « Etirer les niveaux » : il MESURE la carte active, donc il ne
    // peut pas etre teste a vide. Une texture preset est chargee au demarrage.
    const niveaux = await page.evaluate(() => {
      const b = document.getElementById('levels-auto-btn');
      const info = document.getElementById('levels-auto-info');
      if (!b || !info) return { present: false };
      const cacheAvant = info.classList.contains('hidden');
      b.click();
      return {
        present: true,
        visible: b.getBoundingClientRect().width > 0,
        cacheAvant,
        cacheApres: info.classList.contains('hidden'),
        texte: info.textContent.trim(),
      };
    });
    expect(niveaux.present, 'bouton #levels-auto-btn absent du DOM').toBe(true);
    expect(niveaux.visible, 'bouton present mais invisible').toBe(true);
    expect(niveaux.cacheAvant, 'la ligne de diagnostic doit demarrer masquee').toBe(true);
    expect(niveaux.cacheApres, 'le bouton doit publier son diagnostic').toBe(false);
    // Un bouton qui agit sans rien dire laisserait l'utilisateur sans moyen de
    // juger : le diagnostic doit porter une MESURE, pas un simple accuse.
    expect(niveaux.texte, `diagnostic sans mesure : "${niveaux.texte}"`).toMatch(/\d/);

    expect(etat.present, 'controle #seam-width absent du DOM').toBe(true);
    expect(etat.visible, 'controle present mais invisible').toBe(true);
    // Defaut 0 = desactive : la fonctionnalite ne doit rien changer tant que
    // l'utilisateur ne l'a pas demandee.
    expect(etat.avant, 'la largeur de couture doit demarrer a 0 (desactivee)').toBe(0);
    expect(etat.apres, "le champ ne suit pas le curseur : linkSlider n'est pas branche").toBe(3.5);

    expect(erreurs, `erreurs pendant le pilotage:\n${erreurs.join('\n')}`).toEqual([]);
  } finally {
    await page.evaluate(() => window.bumpforgeElectron?.setDirty(false)).catch(() => {});
    await app.close();
  }
});
