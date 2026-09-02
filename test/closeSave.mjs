// FERMER AVEC « ENREGISTRER » : LE REFUS DIT-IL SA RAISON ?
//
// LE DEFAUT (rapporte en GUI : « le programme ne se ferme pas du fait des
// sauvegardes demandees »)
// ---------------------------------------------------------------------------
// Le processus principal n'autorise la fermeture que sur `saveDone(true)`
// (electron-main.js : `if (ok && mainWindow) { allowClose = true; ... }`). Le
// gestionnaire du renderer rendait `false` dans trois cas, et MUET a chaque
// fois : sauvegarde deja en vol (`{busy:true}`), selecteur de fichier annule
// (`{canceled:true}`), et exception avalee par un `catch` vide. La fenetre
// restait ouverte sans rien dire — ce qui se lit comme un blocage.
//
// CE QU'ON NE PEUT PAS TESTER ICI, ET POURQUOI
// -------------------------------------------
// Le gestionnaire vit dans `main.js`, qui n'est pas importable hors DOM, et le
// declencheur est un dialogue NATIF du processus principal. L'oracle est donc au
// niveau du SOURCE, comme previewParity.mjs : il pince chacune des trois issues
// et le contrat cote processus principal. Il ne remplace pas un clic sur la
// croix — il empeche la regression silencieuse de revenir.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');
const MAIN     = strip(readFileSync(join(root, 'js', 'main.js'), 'utf8'));
const ELECTRON = strip(readFileSync(join(root, 'electron-main.js'), 'utf8'));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

// Le corps du gestionnaire de demande de sauvegarde.
const iH = MAIN.indexOf('onSaveRequest');
const HANDLER = iH >= 0 ? MAIN.slice(iH, MAIN.indexOf('saveDone', iH) + 40) : '';

console.log('\n1. Le contrat cote processus principal');

check('la fermeture est conditionnee a saveDone(true)', () => {
  // Si ce contrat changeait, tout le reste de ce fichier deviendrait sans objet.
  assert.match(ELECTRON, /ipcMain\.on\('app-save-done'/,
    "le processus principal n'ecoute plus la reponse du renderer");
  assert.match(ELECTRON, /if \(ok && mainWindow\)[\s\S]{0,80}allowClose\s*=\s*true/,
    'la fermeture ne depend plus de la reponse : cet oracle est a reecrire');
});

console.log('\n2. Les trois issues du gestionnaire');

check('le gestionnaire existe et repond toujours', () => {
  assert.ok(HANDLER.length > 0, 'gestionnaire onSaveRequest introuvable');
  assert.match(HANDLER, /saveDone\?\.\(ok\)/,
    'sans reponse, la fenetre reste bloquee pour de bon');
});

check('une sauvegarde EN VOL est attendue, pas declaree echouee', () => {
  assert.match(MAIN, /let\s+_savePromise/, '_savePromise absente');
  assert.match(MAIN, /_savePromise = \(async \(\) =>/,
    '_runSave ne publie pas la sauvegarde en vol');
  assert.match(MAIN, /finally\s*\{[^}]*_savePromise = null/,
    'une promesse jamais liberee bloquerait toutes les fermetures suivantes');
  assert.match(HANDLER, /await _savePromise/,
    'Ctrl+S puis fermeture : la fermeture echouait sur la sauvegarde en cours');
});

check('une exception est RAPPORTEE, pas avalee', () => {
  // C'est le cas le plus grave : echec d'ecriture, disque plein, chemin refuse.
  assert.ok(!/catch\s*\{\s*ok = false;\s*\}/.test(HANDLER),
    'le catch vide est de retour : un echec de sauvegarde redevient invisible');
  assert.match(HANDLER, /catch \(err\)[\s\S]{0,200}showToast/,
    "l'exception doit produire un message a l'ecran");
  assert.match(HANDLER, /toasts\.saveFailed/, 'message d\'echec non traduit');
  assert.match(HANDLER, /err\?\.message/,
    'le message doit porter la CAUSE, pas un accuse generique');
});

check('une erreur rendue en VALEUR est traitee comme une exception', () => {
  // saveProjectToPath rend {error} sans lever : sans ce relais, l'echec
  // repasserait en silence.
  assert.match(HANDLER, /if \(r\?\.error\) throw new Error\(r\.error\)/,
    "un resultat {error} doit rejoindre le chemin d'erreur");
});

check('un selecteur de fichier annule le DIT', () => {
  assert.match(HANDLER, /r\?\.canceled[\s\S]{0,200}toasts\.closeCancelled/,
    'annuler la sauvegarde annule la fermeture : legitime, mais il faut le dire');
});

check('deja sauve entre-temps = fermeture autorisee', () => {
  // Sans ce cas, attendre la sauvegarde en vol puis relancer saveProject()
  // rouvrirait un selecteur de fichier pour un projet deja propre.
  assert.match(HANDLER, /if \(!projectDirty\)[\s\S]{0,80}ok = true/,
    'un projet devenu propre pendant l\'attente doit fermer sans re-sauver');
});

console.log('\n3. Les traductions');

for (const lang of ['en', 'fr', 'de', 'es', 'it', 'pt', 'ja', 'ko']) {
  check(`${lang} porte les deux messages`, () => {
    const src = readFileSync(join(root, 'js', 'i18n', `${lang}.js`), 'utf8');
    assert.match(src, /"toasts\.closeCancelled":/, 'toasts.closeCancelled absente');
    assert.match(src, /"toasts\.saveFailed":/, 'toasts.saveFailed absente');
    // Le message d'echec doit porter le trou d'interpolation, sinon la cause
    // est perdue a la traduction.
    assert.match(src, /"toasts\.saveFailed":[^\n]*\{msg\}/,
      'toasts.saveFailed sans {msg} : la cause disparait dans cette langue');
  });
}

console.log(`\n${pass} ok, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
