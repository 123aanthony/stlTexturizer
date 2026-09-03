// Shared Electron launcher for the e2e specs: fresh temp userData profile.
//
// Why: with the USER's real profile, the boot-time custom-texture-library scan
// can push hundreds of MB of dataURLs while Playwright's CDP debugger is
// attached — the DevTools connection buffer (256 MB) overflows and the test
// browser dies ("Target page, context or browser has been closed"). A clean
// profile removes that and makes runs reproducible.

import { _electron as electron } from '@playwright/test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ LES PROFILS TEMPORAIRES NE SE NETTOYAIENT JAMAIS. Chaque lancement en cree
// un ; chaque `npm run test:e2e` en laisse une quinzaine derriere lui, pour
// toujours. MESURE le 03/09 sur la machine de developpement : **322 dossiers,
// 2.5 Go**. Rien ne casse — c'est juste une fuite lente, du genre qu'on ne
// remarque qu'en cherchant autre chose.
//
// Le balayage se fait a l'OUVERTURE et par AGE, pas a la fermeture : un profil
// encore en service ne peut pas etre supprime sous Windows, et une suppression
// en fin de test echouerait en silence sur le premier cas interrompu. Une heure
// de sursis suffit a ne jamais toucher un profil du run en cours, meme quand
// plusieurs suites s'enchainent.
const AGE_MAX_MS = 60 * 60 * 1000;

function balayerAnciensProfils() {
  const base = tmpdir();
  let retires = 0;
  try {
    for (const nom of readdirSync(base)) {
      if (!nom.startsWith('bumpforge-e2e-')) continue;
      const p = join(base, nom);
      try {
        if (Date.now() - statSync(p).mtimeMs < AGE_MAX_MS) continue;
        rmSync(p, { recursive: true, force: true });
        retires++;
      } catch { /* profil verrouille ou deja parti : tant pis, on reessaiera */ }
    }
  } catch { /* pas de /tmp lisible : le nettoyage n'est pas la mission */ }
  if (retires) console.log(`  (nettoyage : ${retires} profil(s) e2e perime(s) retire(s))`);
}

/**
 * @param appRoot        racine de l'app
 * @param opts.userData  profil a REUTILISER. Sans lui, un profil neuf par appel
 *   (le comportement historique, inchange). Le passer permet de relancer l'app
 *   sur le MEME profil : c'est ainsi qu'on eprouve ce qui doit survivre a la
 *   fermeture — la bibliotheque de matieres vit dans IndexedDB, donc dans ce
 *   dossier, et un test qui ne quitterait jamais l'app ne prouverait rien de sa
 *   durabilite. Le profil rendu permet a l'appelant de le reutiliser.
 */
export async function launchApp(appRoot, { userData: reuse = null } = {}) {
  if (!reuse) balayerAnciensProfils();
  const userData = reuse || mkdtempSync(join(tmpdir(), 'bumpforge-e2e-'));
  const app = await electron.launch({
    args: [appRoot],
    env: { ...process.env, BF_TEST_USERDATA: userData },
  });
  // ⚠️ LE DIALOGUE DE FERMETURE BLOQUE LA FIN DE CHAQUE TEST.
  // `electron-main.js` intercepte `close` et, projet SALE, ouvre un dialogue
  // NATIF modal « Enregistrer / Ne pas enregistrer / Annuler ». C'est le bon
  // comportement pour l'utilisateur — et un piege mortel en e2e : personne ne
  // clique, `app.close()` ne rend jamais la main, Playwright annonce « Worker
  // teardown timeout » et compte le test en ECHEC. MESURE : une app sans rien
  // de charge se ferme en 0.2 s ; des qu'un modele est charge (donc le projet
  // sali), la fermeture ne revient plus.
  // ⚠️ Le symptome TROMPE : le test qui echoue est celui qui vient de finir, et
  // il a l'air de bloquer sur sa DERNIERE assertion. On accuse la lenteur de la
  // machine ou le chargement du STEP — nous l'avons fait — alors que tout le
  // corps du test s'etait deroule en quelques secondes.
  // On repond donc « Ne pas enregistrer » (index 1), le seul choix qui ferme
  // sans ecrire : un test ne doit jamais laisser de fichier derriere lui.
  await app.evaluate(async ({ dialog }) => {
    dialog.showMessageBoxSync = () => 1;
    dialog.showMessageBox = async () => ({ response: 1 });
  });

  const page = await app.firstWindow();

  // ⚠️ ECOUTEURS ATTACHES IMMEDIATEMENT, avant le moindre delai.
  // Une erreur d'EVALUATION DE MODULE (import en double, par exemple) survient a
  // la milliseconde zero et tue main.js en entier. Les attacher apres l'attente
  // ci-dessous la rendait invisible : le smoke annoncait « demarre sans erreur »
  // pendant que l'app n'avait construit ni grille de textures ni ecouteurs.
  const bootErrors = [];
  page.on('pageerror', (e) => bootErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') bootErrors.push(m.text()); });

  await page.waitForLoadState('domcontentloaded');

  // Clean profile = first run → the welcome overlay may cover the viewport and
  // swallow canvas clicks. Dismiss it when present.
  const gotIt = page.locator('#welcome-got-it');
  await page.waitForTimeout(600);
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();

  return { app, page, bootErrors, userData };
}
