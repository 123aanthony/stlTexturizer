// Aucun réglage ne doit tomber dans un trou de persistance.
//
// LE DEFAUT TROUVE
// ----------------
// Un reglage de `settings` peut etre sauvegarde par DEUX canaux :
//   - PERSISTED_KEYS      -> le snapshot global, ecrit a la racine du projet ;
//   - les reglages de SLOT -> `stripGlobalQuality({...settings})`, qui RETIRE
//     tout ce qui figure dans GLOBAL_EXPORT_QUALITY_KEYS.
// Une cle qui est dans GLOBAL_EXPORT_QUALITY_KEYS mais PAS dans PERSISTED_KEYS
// n'est donc ecrite NULLE PART. MESURE avant correctif : 9 cles dans ce cas —
// `decimateEnabled` et les 8 `regularize*`. L'utilisateur decochait « Reduire
// aux triangles de sortie », enregistrait, rouvrait, et l'export re-decimait
// sans un mot. Ces reglages pilotent la GEOMETRIE exportee, pas l'affichage.
//
// POURQUOI CE TEST PLUTOT QU'UN SIMPLE CORRECTIF
// ----------------------------------------------
// PERSISTED_KEYS est une liste d'INCLUSION tenue a la main. Elle se perime en
// silence a chaque nouveau reglage — c'est exactement ce qui s'est produit
// pour ces 9-la. Corriger la liste sans poser ce garde-fou reviendrait a
// attendre le prochain oubli. Le test DERIVE la couverture du code lui-meme,
// donc il suit les evolutions au lieu de les subir.
//
// Il lit les trois listes par ANALYSE DE TEXTE : `main.js` n'est pas importable
// (9000 lignes de DOM). C'est une limite assumee, et le compteur ci-dessous
// echoue si l'extraction rend un resultat vide — un scan muet passerait sinon
// tous les tests sans rien verifier.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Source DEBARRASSEE DE SES COMMENTAIRES.
 *
 * ⚠️ Paye DEUX fois dans la meme journee. Sans ce nettoyage, les apostrophes
 * des commentaires francais (« L'utilisateur decochait... ») sont capturees
 * comme des litteraux de chaine et polluent l'extraction de PERSISTED_KEYS avec
 * des fragments de phrase. Une analyse de texte qui ne distingue pas le code du
 * commentaire ne mesure pas ce qu'elle croit.
 */
const decomment = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');
const MAIN = decomment(readFileSync(join(here, '..', 'js', 'main.js'), 'utf8'));
const SLOT = decomment(readFileSync(join(here, '..', 'js', 'slotState.js'), 'utf8'));

/** Cles d'un litteral d'objet, depuis son ouverture jusqu'au `};` de colonne 0. */
function objectKeys(src, opening) {
  const i = src.indexOf(opening);
  assert.ok(i > 0, `bloc introuvable : ${opening}`);
  const body = src.slice(i, src.indexOf('\n};', i));
  // ⚠️ TOUTES les cles, pas seulement la premiere de chaque ligne : l'objet en
  // declare plusieurs par ligne (`mapBlack: 0, mapWhite: 1, mapGamma: 1,`), et
  // un regex ancre en debut de ligne n'en voyait qu'une sur trois — ce qui
  // faisait passer les deux autres pour ABSENTES de settings.
  return [...body.matchAll(/([A-Za-z_]\w*)\s*:/g)].map((m) => m[1]);
}

/** Litteraux d'un tableau de chaines. */
function arrayStrings(src, opening) {
  const i = src.indexOf(opening);
  assert.ok(i > 0, `tableau introuvable : ${opening}`);
  const body = src.slice(i, src.indexOf('];', i));
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const settingsKeys = objectKeys(MAIN, 'const settings = {');
const persisted    = arrayStrings(MAIN, 'const PERSISTED_KEYS = [');
const globalQuality = arrayStrings(SLOT, 'GLOBAL_EXPORT_QUALITY_KEYS = [');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

// Exclusions DELIBEREES, chacune justifiee. Toute autre cle orpheline echoue.
const TRANSITOIRES = new Set([
  // Etat d'affichage pur : « montrer le relief ou non ». Le restaurer
  // rouvrirait le projet dans un mode que l'utilisateur n'a pas demande, et le
  // commentaire de PERSISTED_KEYS l'exclut nommement.
  'useDisplacement',
]);

console.log('\n1. Extraction');

check('les trois listes sont extraites et non vides', () => {
  // Un scan muet rendrait des listes vides et ferait passer tout le reste.
  assert.ok(settingsKeys.length >= 30, `settings : ${settingsKeys.length} cles, extraction suspecte`);
  assert.ok(persisted.length >= 30, `PERSISTED_KEYS : ${persisted.length} cles`);
  assert.ok(globalQuality.length >= 10, `GLOBAL_EXPORT_QUALITY_KEYS : ${globalQuality.length} cles`);
  console.log(`       settings ${settingsKeys.length} | snapshot ${persisted.length} | globales ${globalQuality.length}`);
});

console.log('\n2. Couverture');

check('AUCUN reglage n\'est orphelin des deux canaux', () => {
  const orphelines = settingsKeys.filter((k) =>
    !persisted.includes(k) &&        // pas dans le snapshot global
    globalQuality.includes(k) &&     // et retire des reglages de slot
    !TRANSITOIRES.has(k));
  assert.deepEqual(orphelines, [],
    'ces reglages ne sont ecrits NULLE PART (ni snapshot, ni slot) :\n         ' +
    orphelines.join('\n         ') +
    '\n       -> les ajouter a PERSISTED_KEYS, ou les sortir de GLOBAL_EXPORT_QUALITY_KEYS.');
});

check('tout reglage hors snapshot est bien sauve PAR SLOT', () => {
  // Le complement du test precedent : une cle absente du snapshot est
  // acceptable, mais SEULEMENT si les reglages de slot la portent.
  const perdues = settingsKeys.filter((k) =>
    !persisted.includes(k) && globalQuality.includes(k) && !TRANSITOIRES.has(k));
  assert.equal(perdues.length, 0, `${perdues.length} cles perdues : ${perdues.join(', ')}`);
});

check('PERSISTED_KEYS ne reference pas de reglage inexistant', () => {
  // L'inverse du trou : une cle renommee dans `settings` mais laissee ici
  // ecrirait `undefined` dans le projet, silencieusement.
  const fantomes = persisted.filter((k) =>
    !settingsKeys.includes(k) && k !== 'activeMapName');
  assert.deepEqual(fantomes, [], `cles du snapshot absentes de settings : ${fantomes.join(', ')}`);
});

console.log('\n3. Les reglages ajoutes recemment');

check('les 12 reglages recents sont tous couverts', () => {
  // Verification NOMMEE : ceux-la sont neufs, donc les plus exposes a l'oubli.
  const recents = [
    'textureAntialias', 'displayCreaseAngle',
    'mapBlack', 'mapWhite', 'mapGamma', 'mapMacro', 'mapMicro', 'mapSplitMm',
    'pieceOffset', 'pieceRotate', 'pieceFlip', 'pieceSeed',
  ];
  const absents = recents.filter((k) => !settingsKeys.includes(k));
  assert.deepEqual(absents, [], `absents de settings : ${absents.join(', ')}`);
  const nonSauves = recents.filter((k) => !persisted.includes(k));
  assert.deepEqual(nonSauves, [], `non sauvegardes : ${nonSauves.join(', ')}`);
});

check('le partage global / par-slot des reglages recents est le bon', () => {
  // Ce qui se calibre sur le CONTENU d'une carte est par slot ; ce qui decrit
  // l'echantillonnage ou la vue est global (cf. slotState.js).
  for (const k of ['textureAntialias', 'displayCreaseAngle']) {
    assert.ok(globalQuality.includes(k), `${k} devrait etre GLOBAL`);
  }
  for (const k of ['mapBlack', 'mapWhite', 'mapGamma', 'mapMacro', 'mapMicro',
                   'mapSplitMm', 'pieceOffset', 'pieceRotate', 'pieceFlip']) {
    assert.ok(!globalQuality.includes(k), `${k} devrait etre PAR SLOT`);
  }
});

console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
