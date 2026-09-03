// BIBLIOTHEQUE DE MATIERES PAR COULEUR — invariants.
//
// Ce que ces controles protegent, dans l'ordre d'importance :
//   1. une matiere ne doit JAMAIS atterrir sur la mauvaise couleur (peindre un
//      chainage en voussoir ne leve aucune erreur et ne se voit qu'au rendu) ;
//   2. le resultat ne doit PAS dependre de l'ordre d'insertion ;
//   3. une bibliotheque relue du disque doit survivre a n'importe quoi sans
//      propager une entree a moitie fausse ;
//   4. elle ne doit pas grossir indefiniment (les cartes pesent des Mo).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  colorKey, keyToRgb, normalizeRgb, colorDistance,
  emptyLibrary, normalizeLibrary, putMaterial, removeMaterial, pruneMaps,
  lookupMaterial, planFromGroups, librarySize, mapContentKey,
  DEFAULT_TOLERANCE, LIBRARY_VERSION,
} from '../js/materialLibrary.js';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

const mat = (preset, settings = {}) => ({
  activeMapType: 'preset', presetName: preset,
  customMapName: null, customMapKey: null, settings,
});

// Les vraies teintes de fw_colorize : trois pierres VOLONTAIREMENT contrastees
// (gris froid / sable chaud / gris-bleu) et du bois. Les valeurs exactes
// importent peu ; ce qui compte est qu'elles soient distinctes a l'oeil et que
// le seuil ne les confonde pas.
const PIERRE_ARCHE    = [0.62, 0.64, 0.67];
const PIERRE_CHAINAGE = [0.80, 0.73, 0.58];
const BOIS            = [0.45, 0.32, 0.20];

console.log('\n1. Cle de couleur');

check('flottants 0..1 et octets 0..255 donnent la MEME cle', () => {
  assert.equal(colorKey([1, 0, 1]), colorKey([255, 0, 255]));
  assert.equal(colorKey([0.5, 0.25, 0]), colorKey([127.5, 63.75, 0]));
});

check('la detection octets/flottants se fait sur le MAX des canaux', () => {
  // (255, 0, 0) est du rouge en octets. Un test canal par canal aurait vu
  // "0 <= 1" sur deux canaux et fabrique une couleur absurde.
  assert.equal(colorKey([255, 0, 0]), '#ff0000');
  assert.equal(colorKey([1, 0, 0]), '#ff0000');
});

check('aller-retour cle <-> rgb', () => {
  const k = colorKey(PIERRE_ARCHE);
  const rgb = keyToRgb(k);
  assert.ok(colorDistance(rgb, PIERRE_ARCHE) < 1 / 255);
  assert.equal(colorKey(rgb), k);
});

check('entrees invalides rendent null, pas une cle bidon', () => {
  assert.equal(colorKey(null), null);
  assert.equal(colorKey([1, 2]), null);
  assert.equal(colorKey([NaN, 0, 0]), null);
  assert.equal(keyToRgb('rouge'), null);
  assert.equal(keyToRgb('#12345'), null);
});

console.log('\n2. La correspondance se fait au PLUS PROCHE, pas au premier trouve');

check('deux teintes voisines : chacune retrouve LA sienne', () => {
  // Le cas qui motive le module : fw_colorize decoupe le bois en sous-couleurs
  // de DIRECTION DE FIL, donc des teintes proches coexistent.
  const a = [0.450, 0.320, 0.200];
  const b = [0.458, 0.320, 0.200];          // 0.008 plus loin : sous le seuil
  let lib = emptyLibrary();
  lib = putMaterial(lib, a, { name: 'bois fil X', material: mat('Wood') });
  lib = putMaterial(lib, b, { name: 'bois fil Y', material: mat('Weave 1') });
  assert.equal(lookupMaterial(lib, a).name, 'bois fil X');
  assert.equal(lookupMaterial(lib, b).name, 'bois fil Y');
});

check('le resultat NE DEPEND PAS de l ordre d insertion', () => {
  const a = [0.450, 0.320, 0.200], b = [0.458, 0.320, 0.200];
  let l1 = emptyLibrary();
  l1 = putMaterial(l1, a, { name: 'A', material: mat('Wood') });
  l1 = putMaterial(l1, b, { name: 'B', material: mat('Weave 1') });
  let l2 = emptyLibrary();
  l2 = putMaterial(l2, b, { name: 'B', material: mat('Weave 1') });
  l2 = putMaterial(l2, a, { name: 'A', material: mat('Wood') });
  for (const c of [a, b]) {
    assert.equal(lookupMaterial(l1, c).name, lookupMaterial(l2, c).name,
      'la meme couleur rend deux matieres selon l ordre de memorisation');
  }
});

check('au-dela du seuil : AUCUNE matiere, jamais la moins pire', () => {
  let lib = putMaterial(emptyLibrary(), PIERRE_ARCHE,
                        { name: 'voussoir', material: mat('Brick') });
  assert.ok(lookupMaterial(lib, PIERRE_CHAINAGE) === null,
    'le chainage a recu la matiere du voussoir');
  // et la distance qui le justifie est bien au-dessus du seuil
  assert.ok(colorDistance(PIERRE_ARCHE, PIERRE_CHAINAGE) > DEFAULT_TOLERANCE * 3);
});

check('l aller-retour STEP (arrondi 8 bits) reste sous le seuil', () => {
  // La couleur ecrite par FreeCAD revient quantifiee : c est CE bruit-la que le
  // seuil doit absorber, et rien de plus.
  let lib = putMaterial(emptyLibrary(), PIERRE_ARCHE,
                        { name: 'voussoir', material: mat('Brick') });
  const requantifie = keyToRgb(colorKey(PIERRE_ARCHE));
  const hit = lookupMaterial(lib, requantifie);
  assert.ok(hit, 'la couleur ne se retrouve plus apres un aller-retour 8 bits');
  assert.ok(hit.distance < 1 / 255);
});

console.log('\n3. Memoriser / oublier');

check('memoriser deux fois la meme couleur REMPLACE', () => {
  let lib = putMaterial(emptyLibrary(), BOIS, { name: 'v1', material: mat('Wood') });
  lib = putMaterial(lib, BOIS, { name: 'v2', material: mat('Knitting') });
  assert.equal(librarySize(lib), 1);
  assert.equal(lookupMaterial(lib, BOIS).material.presetName, 'Knitting');
});

check('putMaterial est PURE (l entree n est pas mutee)', () => {
  const lib0 = emptyLibrary();
  const lib1 = putMaterial(lib0, BOIS, { name: 'bois', material: mat('Wood') });
  assert.equal(librarySize(lib0), 0, 'la bibliotheque source a ete mutee');
  assert.equal(librarySize(lib1), 1);
});

check('oublier une couleur', () => {
  let lib = putMaterial(emptyLibrary(), BOIS, { name: 'bois', material: mat('Wood') });
  lib = removeMaterial(lib, BOIS);
  assert.equal(librarySize(lib), 0);
  assert.equal(lookupMaterial(lib, BOIS), null);
});

check('les reglages sont COPIES, pas alias', () => {
  const settings = { scaleU: 12, amplitude: 0.4 };
  let lib = putMaterial(emptyLibrary(), BOIS, { name: 'bois', material: mat('Wood', settings) });
  settings.scaleU = 999;
  assert.equal(lookupMaterial(lib, BOIS).material.settings.scaleU, 12);
});

console.log('\n4. Les octets de carte : une seule copie, et pas de fuite');

check('une carte personnalisee est rangee une fois et ressort au lookup', () => {
  const url = 'data:image/png;base64,AAAA';
  const key = mapContentKey(url);
  const m = { activeMapType: 'custom', presetName: null, customMapName: 'p.png',
              customMapKey: key, settings: {} };
  const lib = putMaterial(emptyLibrary(), BOIS, { name: 'bois', material: m, mapDataUrl: url });
  assert.equal(Object.keys(lib.maps).length, 1);
  assert.equal(lookupMaterial(lib, BOIS).mapDataUrl, url);
});

check('remplacer une matiere ne laisse pas trainer l ancienne image', () => {
  // Sans elagage, la bibliotheque ne fait que grossir — et c est le poste lourd.
  const url1 = 'data:image/png;base64,AAAA', url2 = 'data:image/png;base64,BBBB';
  const m = (u) => ({ activeMapType: 'custom', presetName: null, customMapName: 'p.png',
                      customMapKey: mapContentKey(u), settings: {} });
  let lib = putMaterial(emptyLibrary(), BOIS, { name: 'bois', material: m(url1), mapDataUrl: url1 });
  lib = putMaterial(lib, BOIS, { name: 'bois', material: m(url2), mapDataUrl: url2 });
  assert.equal(Object.keys(lib.maps).length, 1, 'l ancienne image survit a son remplacement');
  assert.equal(lookupMaterial(lib, BOIS).mapDataUrl, url2);
});

check('deux couleurs qui partagent une image la partagent VRAIMENT', () => {
  const url = 'data:image/png;base64,AAAA';
  const m = { activeMapType: 'custom', presetName: null, customMapName: 'p.png',
              customMapKey: mapContentKey(url), settings: {} };
  let lib = putMaterial(emptyLibrary(), BOIS, { name: 'a', material: m, mapDataUrl: url });
  lib = putMaterial(lib, PIERRE_ARCHE, { name: 'b', material: m, mapDataUrl: url });
  assert.equal(Object.keys(lib.maps).length, 1);
  // et oublier l une ne prive pas l autre de son image
  lib = removeMaterial(lib, BOIS);
  assert.equal(lookupMaterial(lib, PIERRE_ARCHE).mapDataUrl, url);
});

check('mapContentKey est bien celle de main.js (contenu ET longueur)', () => {
  assert.equal(mapContentKey('abc'), mapContentKey('abc'));
  assert.notEqual(mapContentKey('abc'), mapContentKey('abd'));
  assert.match(mapContentKey('abc'), /^m[0-9a-z]+-[0-9a-z]+$/);
});

console.log('\n5. Relecture depuis le disque : tolerante, mais jamais credule');

check('n importe quoi rend une bibliotheque VIDE, pas une exception', () => {
  for (const bad of [null, undefined, 42, 'x', [], {}, { entries: 3 }]) {
    const lib = normalizeLibrary(bad);
    assert.equal(librarySize(lib), 0);
    assert.equal(lib.version, LIBRARY_VERSION);
  }
});

check('une entree malformee est ECARTEE, les saines sont gardees', () => {
  const raw = {
    version: 1,
    entries: {
      '#a0b0c0': { name: 'bonne', material: { activeMapType: 'preset', presetName: 'Brick', settings: {} } },
      'pas-une-cle': { name: 'x', material: { presetName: 'Brick' } },
      '#ffffff': { name: 'sans matiere' },
      '#000000': { name: 'matiere pas un objet', material: 'Brick' },
    },
    maps: { m1: 'data:...', m2: 42 },
  };
  const lib = normalizeLibrary(raw);
  assert.equal(librarySize(lib), 1);
  assert.ok(lib.entries['#a0b0c0']);
  assert.deepEqual(Object.keys(lib.maps), ['m1'], 'une valeur de carte non-chaine a survecu');
});

check('les cles sont normalisees en minuscules', () => {
  const lib = normalizeLibrary({ entries: { '#A0B0C0': { name: 'x', material: { settings: {} } } } });
  assert.ok(lib.entries['#a0b0c0'], 'une cle majuscule ne se retrouve plus');
});

console.log('\n6. Plan d application sur des groupes');

check('un element par groupe, dans l ORDRE, null quand inconnu', () => {
  let lib = putMaterial(emptyLibrary(), BOIS, { name: 'bois', material: mat('Wood') });
  lib = putMaterial(lib, PIERRE_ARCHE, { name: 'voussoir', material: mat('Brick') });
  const groups = [{ rgb: PIERRE_CHAINAGE }, { rgb: BOIS }, { rgb: null }, { rgb: PIERRE_ARCHE }];
  const plan = planFromGroups(lib, groups);
  assert.equal(plan.length, 4);
  assert.equal(plan[0], null, 'une couleur inconnue doit rendre null, pas la moins pire');
  assert.equal(plan[1].name, 'bois');
  assert.equal(plan[2], null);
  assert.equal(plan[3].name, 'voussoir');
  // C'est ce comptage qui permet de DIRE "2 matieres reconnues sur 4".
  assert.equal(plan.filter(Boolean).length, 2);
});

check('bibliotheque vide : plan entierement nul, aucune exception', () => {
  const plan = planFromGroups(emptyLibrary(), [{ rgb: BOIS }, { rgb: PIERRE_ARCHE }]);
  assert.deepEqual(plan, [null, null]);
});

check('groupes absents ou vides : plan vide', () => {
  assert.deepEqual(planFromGroups(emptyLibrary(), null), []);
  assert.deepEqual(planFromGroups(emptyLibrary(), []), []);
});

console.log('\n7. Cablage dans main.js');
//
// ⚠️ Ce sont des controles de CABLAGE, pas de comportement — ils lisent le
// source. Un oracle de cablage ne remplace pas un oracle de comportement (lecon
// de bootFallback.mjs, ou les gardes de cablage etaient poses et la vraie cause
// etait ailleurs). Ils sont ici parce que les trois defauts qu'ils attrapent
// sont MUETS : rien ne planterait, la bibliotheque semblerait juste ne jamais
// reconnaitre une matiere. Le comportement complet demande la vraie app (e2e).

const MAIN = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');   // sans commentaires

check('colorKey est ECRIT dans le projet ET RELU', () => {
  // Le demi-cablage est le defaut classique : ecrire sans relire (la couleur
  // est perdue a la reouverture) ou relire sans ecrire (elle ne revient
  // jamais). Les deux sens, ou rien.
  assert.match(MAIN, /colorKey:\s*slot\.colorKey\s*\|\|\s*null/,
    'colorKey n est pas ecrit dans la charge utile du projet');
  assert.match(MAIN, /slot\.colorKey\s*=\s*typeof saved\.colorKey === 'string'/,
    'colorKey n est pas relu a la restauration du projet');
});

check('un slot neuf porte le champ (sinon il naitrait undefined)', () => {
  const i = MAIN.indexOf('function createTextureSlot(');
  assert.ok(i > 0, 'createTextureSlot introuvable');
  assert.match(MAIN.slice(i, i + 500), /colorKey:\s*null/,
    'createTextureSlot ne pose pas colorKey');
});

check('la pose automatique est ATTENDUE (await)', () => {
  // Elle est devenue asynchrone (resolution des cartes). Sans await, les
  // matieres arriveraient APRES renderTextureTabs et le toast : l ecran
  // afficherait des slots nus, puis changerait tout seul — ou pas du tout.
  assert.match(MAIN, /await\s+_autoSlotsFromColorGroups\s*\(/,
    '_autoSlotsFromColorGroups n est pas attendue a son site d appel');
  assert.match(MAIN, /async function _autoSlotsFromColorGroups\s*\(/,
    '_autoSlotsFromColorGroups n est plus asynchrone');
});

check('la matiere memorisee vient de pickSlotMaterial (source unique)', () => {
  // Le pinceau de materiau et la bibliotheque doivent repondre LA MEME chose a
  // "qu'est-ce qu'une matiere". Deux definitions divergeraient en silence : on
  // copierait une matiere autrement qu'on la memorise.
  const i = MAIN.indexOf('function _slotMaterialPayload(');
  assert.ok(i > 0, '_slotMaterialPayload introuvable');
  assert.match(MAIN.slice(i, i + 900), /pickSlotMaterial\s*\(\s*slot\s*\)/,
    '_slotMaterialPayload n utilise plus pickSlotMaterial');
});

check('mapContentKey n a plus de copie locale dans main.js', () => {
  assert.ok(!/function\s+mapContentKey\s*\(/.test(MAIN),
    'une seconde definition de mapContentKey est reapparue dans main.js');
  assert.match(MAIN, /import\s*\{[^}]*mapContentKey[^}]*\}\s*from\s*'\.\/materialLibrary\.js'/,
    'main.js n importe plus mapContentKey de la bibliotheque');
});

check('une copie de slot n herite PAS de la couleur', () => {
  // Deux slots de meme couleur se disputeraient l entree de la bibliotheque.
  const i = MAIN.indexOf('copy.activeMapEntry = source.activeMapEntry');
  assert.ok(i > 0, 'le duplicateur de slot est introuvable');
  assert.ok(!/copy\.colorKey\s*=/.test(MAIN.slice(i, i + 600)),
    'la copie herite de colorKey');
});

console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
