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
  const { app, page } = await launchApp(appRoot);
  try {
    const errors = [];
    let crashed = false;
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('crash', () => { crashed = true; });

    await expect(page).toHaveTitle(/bump|stl/i);

    // The viewer canvas (#viewport) is static in index.html but the WebGL
    // context is created by main.js initViewer(); if that throws or the GPU is
    // unavailable the renderer dies and this won't resolve.
    await expect(page.locator('#viewport')).toBeAttached();

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

