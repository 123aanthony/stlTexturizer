// Le repli de demarrage ne doit jamais passer par-dessus une restauration.
//
// LE DEFAUT, en deux moities
// --------------------------
// Le bloc de selection initiale vit dans le `.then()` de `loadAllThumbnails()`.
// Il s'execute donc APRES la restauration d'un projet, et ecrasait ce qu'elle
// venait de poser. Deux chemins distincts y menaient :
//
//   1. `persistedName` existe mais ne designe aucun preset -> c'est une carte
//      PERSONNALISEE. Le code repliait sur DEFAULT_PRESET_NAME et remplacait le
//      pointeur du slot. MESURE sur house.bforge : 3 slots portaient
//      `preset/'Crystal'` alors que leur customMapDataUrl de 893 Ko etait la.
//
//   2. `persistedName` est nul (lancement NEUF, sessionStorage vide) ->
//      `applyDefaults` vaut `true`, et selectPreset ne change pas seulement la
//      carte : il appelle `resetMapAdjustments()` et REECRIT `scaleU`. C'est la
//      moitie la plus destructrice, et celle qui produit le symptome « pas les
//      bonnes dimensions ». MESURE : le slot 1 de house.bforge porte
//      `scaleU 30.7` / mode 6, distinct du snapshot global (43.8 / mode 7) — la
//      sauvegarde etait correcte, seule la relecture se faisait ecraser.
//
// PORTEE ASSUMEE
// --------------
// main.js n'est pas importable (9000 lignes de DOM) : ce fichier lit le SOURCE.
// Il prouve que les deux gardes sont CABLEES, pas qu'elles s'executent — le
// comportement de bout en bout est couvert par test/e2e/customMapKept.spec.mjs.
// Les deux se completent : l'e2e ne peut pas piloter la course du cas 2, ce
// test-ci ne peut pas voir un cablage correct mais inoperant.
//
// La source est DEBARRASSEE DE SES COMMENTAIRES avant analyse : sans ca, ce
// fichier-ci passerait au vert en lisant ses propres explications dans main.js.
// Piege deja paye deux fois dans ce projet (previewParity, settingsCoverage).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(here, '..', 'js', 'main.js'), 'utf8');
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

/** Le bloc de selection initiale, isole. */
function bootBlock() {
  const i = SRC.indexOf('let applyDefaults');
  assert.ok(i > 0, 'bloc de selection initiale introuvable');
  const j = SRC.indexOf('selectPreset(targetIdx', i);
  assert.ok(j > i, 'appel a selectPreset introuvable dans le bloc');
  return SRC.slice(i, j + 200);
}

console.log('\n1. Le bloc est bien la (sinon tout le reste ne prouve rien)');

check('le bloc de selection initiale est extrait et non vide', () => {
  const b = bootBlock();
  assert.ok(b.length > 100, `extraction suspecte : ${b.length} caracteres`);
  console.log(`       ${b.length} caracteres analyses`);
});

console.log('\n2. Moitie 1 — la carte personnalisee survit');

check('le repli sur le preset par defaut exige l\'ABSENCE de carte persistee', () => {
  // Sans `&& !persistedName`, un nom de carte personnalisee tombait sur le
  // preset par defaut faute de correspondance dans IMAGE_PRESETS.
  assert.ok(/targetIdx\s*<\s*0\s*&&\s*!persistedName/.test(SRC),
    'le repli DEFAULT_PRESET_NAME n\'est plus garde par !persistedName : '
    + 'une carte personnalisee sera remplacee par le preset par defaut');
});

console.log('\n3. Moitie 2 — la restauration n\'est pas ecrasee');

check('selectPreset est garde par l\'etat activeMapEntry', () => {
  // LE garde du cas 2. `activeMapEntry` est nul tant que personne n'a
  // revendique de carte ; s'il est renseigne, la restauration a deja parle.
  const b = bootBlock();
  assert.ok(/if\s*\(\s*targetIdx\s*>=\s*0\s*&&\s*PRESETS\[targetIdx\]\s*&&\s*!activeMapEntry\b/.test(b),
    'le repli du demarrage n\'est plus garde par !activeMapEntry : il ecrasera '
    + 'la carte ET le scaleU poses par la restauration d\'un projet');
});

check('le garde porte sur un ETAT, pas sur un delai', () => {
  // Un `setTimeout` a la place du garde marcherait « la plupart du temps » et
  // reintroduirait exactement la course qu'on vient de fermer.
  const b = bootBlock();
  assert.ok(!/setTimeout|requestAnimationFrame/.test(b),
    'le bloc de selection initiale contient une temporisation : '
    + 'la course serait seulement deplacee, pas fermee');
});

console.log('\n4. Non-regression — un demarrage VRAIMENT neuf garde ses defauts');

check('applyDefaults reste pilote par l\'absence de carte persistee', () => {
  // Le garde ne doit pas avoir tue le comportement legitime : sur un lancement
  // neuf sans projet, le preset par defaut DOIT s'appliquer avec ses defauts.
  assert.ok(/let\s+applyDefaults\s*=\s*!persistedName/.test(SRC),
    'applyDefaults ne derive plus de persistedName');
});

check('selectPreset applique toujours defaultScale quand on le lui demande', () => {
  const i = SRC.indexOf('if (applyDefaults)');
  assert.ok(i > 0, 'branche applyDefaults introuvable dans selectPreset');
  const body = SRC.slice(i, i + 400);
  assert.ok(body.includes('resetMapAdjustments'), 'la remise a neutre a disparu');
  assert.ok(body.includes('_applyScaleU'), 'l\'application de defaultScale a disparu');
});

console.log('\n5. Moitie 3 — la FENETRE de restauration est couverte');

check('un drapeau COLLANT signale qu\'un projet se charge', () => {
  // `!activeMapEntry` ne couvre pas la boucle de restauration : seuls les
  // slot.activeMapEntry y sont poses, la variable de module reste nulle
  // jusqu'a restoreSlotState(), tout a la fin.
  assert.ok(/let\s+_projectLoadStarted\s*=\s*false\s*;/.test(SRC),
    '_projectLoadStarted n\'est plus declare');
});

check('le repli de demarrage s\'efface devant un projet en cours', () => {
  const b = bootBlock();
  assert.ok(/&&\s*!_projectLoadStarted\s*\)/.test(b),
    'le repli du demarrage n\'est plus garde par !_projectLoadStarted : il '
    + 'ecrira sa carte dans le slot 1 pendant la boucle de restauration');
});

check('le drapeau est pose AVANT le premier await d\'importProject', () => {
  // Le coeur du defaut : un garde arme au milieu du chargement laisse passer
  // tout ce qui se resout avant lui.
  const i = SRC.indexOf('async function importProject');
  assert.ok(i > 0, 'importProject introuvable');
  const fn = SRC.slice(i, i + 3000);
  const iFlag  = fn.indexOf('_projectLoadStarted = true');
  const iAwait = fn.indexOf('await ');
  assert.ok(iFlag > 0, 'importProject ne pose pas _projectLoadStarted');
  assert.ok(iAwait > 0, 'aucun await trouve dans importProject : extraction suspecte');
  assert.ok(iFlag < iAwait,
    `le drapeau est pose APRES le premier await (${iFlag} > ${iAwait}) : `
    + 'tout ce qui se resout entre les deux passe au travers');
});

check('un selectPreset DEJA en vol est invalide par la restauration', () => {
  // Un selectPreset parti avant le chargement a franchi son propre garde et
  // attend loadFullPreset ; a son reveil il ecrirait dans le slot actif. Le
  // compteur de generation est le mecanisme prevu pour ca.
  const i = SRC.indexOf('async function importProject');
  const fn = SRC.slice(i, i + 3000);
  assert.ok(/_selectGeneration\s*\+\+/.test(fn),
    'importProject n\'incremente pas _selectGeneration : un chargement de '
    + 'preset en vol ecrira quand meme sa carte dans le slot actif');
  assert.ok(/if\s*\(\s*gen\s*!==\s*_selectGeneration\s*\)\s*return/.test(SRC),
    'selectPreset ne verifie plus la generation apres son await');
});

check('restoreProjectTextureSlots porte le meme garde', () => {
  const i = SRC.indexOf('async function restoreProjectTextureSlots');
  assert.ok(i > 0, 'restoreProjectTextureSlots introuvable');
  const fn = SRC.slice(i, i + 600);
  assert.ok(fn.includes('_projectLoadStarted = true'),
    'defense en profondeur perdue : un futur appelant n\'heriterait pas du garde');
});

console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
