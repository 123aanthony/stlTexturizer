// LA CARTE « COULEURS PAR SLOT » DIT-ELLE LA VERITE ?
//
// CE QU'ELLE PROMET
// -----------------
// Montrer, en couleur, quelle surface revient a quel slot — et lesquelles ne
// sont texturees par personne. La promesse n'est utile QUE si la reponse est
// celle du fichier exporte : une carte qui montrerait une autre appartenance
// que le STL serait pire qu'aucune carte, puisqu'elle donnerait confiance dans
// un mensonge. Le piege classique est de recopier « la premiere case gagne »
// dans la vue, puis de voir les deux regles diverger a la premiere retouche.
//
// CE QUE CE FICHIER PROUVE
// ------------------------
//   §1 la regle est PARTAGEE, pas recopiee — l'appartenance rendue a la vue et
//      les masques exclusifs de l'export coincident FACE A FACE, sur des cas ou
//      les slots se disputent des faces ;
//   §2 la geometrie d'overlay est juste : rien pour les faces sans proprietaire,
//      une seule teinte par triangle, palette qui recycle au-dela de 12 ;
//   §3 le cablage UI existe et la carte se tait la ou elle ne peut pas etre
//      juste (apercu bake, dont les index de triangle ne sont pas ceux de la
//      selection — meme raison que le garde de peinture).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { ownerSlotOfFaces, buildExclusiveSlotFaceMasks } from '../js/slotMasks.js';
import { buildSlotColorOverlayGeo, expandOwnerThroughParents } from '../js/exclusion.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

const slot = (...faces) => ({ assignedFaces: new Set(faces) });

// ── §1 Une seule regle, partagee avec l'export ──────────────────────────────
console.log('\n1. L\'appartenance affichee est celle de l\'export');

check('la premiere case qui reclame une face la garde', () => {
  // Faces 2 et 3 disputees. L'export les donne au slot 0 ; la vue doit dire
  // pareil, sinon on peint en vert une surface qui sortira en bois.
  const slots = [slot(0, 1, 2, 3), slot(2, 3, 4)];
  const owner = ownerSlotOfFaces(slots, 6);
  assert.deepEqual(Array.from(owner), [0, 0, 0, 0, 1, -1]);
});

check('une face que personne ne reclame vaut -1', () => {
  const owner = ownerSlotOfFaces([slot(1)], 4);
  assert.deepEqual(Array.from(owner), [-1, 0, -1, -1]);
});

check('les index hors du maillage sont ignores, pas plantants', () => {
  // Une selection rechargee depuis un projet peut citer des faces qui
  // n'existent plus (modele remplace par un plus simple).
  const owner = ownerSlotOfFaces([slot(0, 99, -1)], 3);
  assert.deepEqual(Array.from(owner), [0, -1, -1]);
});

check('vue et masques d\'export coincident FACE A FACE', () => {
  // LE test du lot. On fait volontairement se chevaucher trois slots, on
  // subdivise (chaque face originale -> 4 sous-faces), puis on compare ce que
  // la VUE colorierait a ce que l'EXPORT texturerait. Un desaccord, meme sur
  // une face, veut dire que la carte ment.
  const slots = [slot(0, 1, 2), slot(1, 2, 3), slot(3, 4)];
  const ORIG = 6;
  const faceParentId = new Int32Array(ORIG * 4);
  for (let t = 0; t < ORIG; t++) for (let k = 0; k < 4; k++) faceParentId[t * 4 + k] = t;

  const owner = ownerSlotOfFaces(slots, ORIG);
  const { masks, counts } = buildExclusiveSlotFaceMasks(faceParentId, slots);

  let compares = 0;
  for (let sub = 0; sub < faceParentId.length; sub++) {
    const attendu = owner[faceParentId[sub]];
    for (let si = 0; si < slots.length; si++) {
      assert.equal(masks[si][sub], si === attendu ? 1 : 0,
        `sous-face ${sub} : la vue dit slot ${attendu}, l'export dit ${si}=${masks[si][sub]}`);
      compares++;
    }
  }
  // Un oracle qui ne compare rien est vert par accident : on publie le compte.
  assert.ok(compares === faceParentId.length * slots.length && compares > 0,
    'aucune comparaison effectuee');
  assert.deepEqual(counts, [12, 4, 4], `comptes exclusifs inattendus : ${counts}`);
  console.log(`       ${compares} comparaisons, comptes exclusifs ${counts.join('/')}`);
});

// ── §2 La geometrie d'overlay ───────────────────────────────────────────────
console.log('\n2. La geometrie coloree');

/** n triangles alignes, sommets reconnaissables (x = index du triangle). */
function strip(n) {
  const pos = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    for (let v = 0; v < 3; v++) { pos[t * 9 + v * 3] = t; pos[t * 9 + v * 3 + 1] = v; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}
const PAL = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

check('les faces sans proprietaire ne sont PAS emises', () => {
  const geo = buildSlotColorOverlayGeo(strip(5), Int16Array.from([-1, 0, -1, 1, -1]), PAL);
  assert.equal(geo.attributes.position.count / 3, 2,
    'le modele nu doit rester visible sous la carte : une face sans slot ne se colorie pas');
  // Et ce sont bien les BONNES : x = 1 puis x = 3.
  const p = geo.attributes.position.array;
  assert.deepEqual([p[0], p[9]], [1, 3]);
});

check('les 3 sommets d\'un triangle portent la MEME teinte', () => {
  // Sinon three interpole et la face sort en degrade : deux slots voisins
  // deviendraient indiscernables le long de leur frontiere.
  const geo = buildSlotColorOverlayGeo(strip(3), Int16Array.from([0, 1, 2]), PAL);
  const c = geo.attributes.color.array;
  for (let t = 0; t < 3; t++) {
    const attendu = PAL[t];
    for (let v = 0; v < 3; v++) {
      assert.deepEqual(
        [c[t * 9 + v * 3], c[t * 9 + v * 3 + 1], c[t * 9 + v * 3 + 2]], attendu,
        `triangle ${t}, sommet ${v}`);
    }
  }
});

check('la palette recycle au-dela de sa longueur', () => {
  // 13 slots avec 12 teintes : mieux vaut deux slots eloignes de meme couleur
  // qu'un plantage ou une face incolore.
  const geo = buildSlotColorOverlayGeo(strip(2), Int16Array.from([0, 3]), PAL);
  const c = geo.attributes.color.array;
  assert.deepEqual([c[0], c[1], c[2]], PAL[0]);
  assert.deepEqual([c[9], c[10], c[11]], PAL[0], 'slot 3 avec 3 teintes doit retomber sur la 0');
});

check('rien a colorier rend une geometrie VIDE, pas une exception', () => {
  const geo = buildSlotColorOverlayGeo(strip(3), Int16Array.from([-1, -1, -1]), PAL);
  assert.equal(geo.attributes.position.count, 0);
});

check('l\'appartenance se propage aux sous-faces du maillage affiche', () => {
  // Maillage de precision / apercu de deplacement : subdivises. Sans cette
  // etape l'overlay serait bati sur les mauvais index.
  const owner = Int16Array.from([2, -1, 0]);
  const parentMap = Int32Array.from([0, 0, 1, 2, 2, 2]);
  assert.deepEqual(Array.from(expandOwnerThroughParents(owner, parentMap)),
    [2, 2, -1, 0, 0, 0]);
});

// ── §3 Le cablage ───────────────────────────────────────────────────────────
console.log('\n3. Le cablage UI');

const MAIN = readFileSync(join(root, 'js', 'main.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');
const HTML = readFileSync(join(root, 'index.html'), 'utf8');

check('la case a cocher existe dans le pied du viewport', () => {
  assert.match(HTML, /id="slot-colors-toggle"/, 'case absente de index.html');
  assert.match(HTML, /id="slot-legend"/, 'legende absente de index.html');
});

check('les deux surimpressions partagent leur ordonnanceur', () => {
  // Un point d'appel qui ne rafraichirait qu'une des deux cartes laisserait
  // l'autre perimee a l'ecran, en silence.
  assert.match(MAIN, /function scheduleFaceOverlays\(\)/, 'ordonnanceur partage absent');

  // Deux mentions de `scheduleOverlapOverlay()` sont LEGITIMES : sa propre
  // definition, et l'appel que lui fait l'ordonnanceur partage. On les retire,
  // puis toute mention restante est un point d'appel qui rafraichit une seule
  // des deux cartes. (Premiere version de ce controle : « exactement une
  // mention » — elle comptait la definition comme un orphelin et partait rouge
  // sur du code sain.)
  const iFace = MAIN.indexOf('function scheduleFaceOverlays()');
  const finFace = MAIN.indexOf('\n}', iFace);
  assert.ok(iFace >= 0 && finFace > iFace, 'corps de scheduleFaceOverlays introuvable');
  const reste = (MAIN.slice(0, iFace) + MAIN.slice(finFace))
    .replace('function scheduleOverlapOverlay()', ' ');
  const orphelins = [...reste.matchAll(/scheduleOverlapOverlay\(\)/g)].length;
  assert.equal(orphelins, 0,
    `${orphelins} point(s) appellent encore scheduleOverlapOverlay seul : ` +
    'ils ne rafraichissent pas la carte des couleurs');

  // Definition + les trois points d'appel, AU MOINS. Un compte exact serait
  // fragile (le garde de disponibilite l'appelle aussi, et un point d'appel
  // legitime peut s'ajouter) et surtout inutile : c'est l'absence d'orphelin
  // ci-dessus qui porte vraiment l'invariant.
  assert.ok([...MAIN.matchAll(/scheduleFaceOverlays\(\)/g)].length >= 4,
    'des points d\'appel ne passent pas par l\'ordonnanceur partage');
});

check('la carte se tait pendant l\'apercu bake', () => {
  assert.match(MAIN, /function _syncSlotColorsAvailability\(\)/, 'garde absent');
  const a = MAIN.indexOf('function _syncSlotColorsAvailability');
  const body = MAIN.slice(a, MAIN.indexOf('\n}', a));
  assert.match(body, /allSlotsPreviewActive/,
    'le maillage bake n\'a pas les index de la selection : la carte y serait fausse');
  assert.match(body, /slotColorsToggle\.disabled\s*=/,
    'la case doit se griser, pas dessiner quelque chose de faux');
  assert.match(MAIN, /function _refreshPreviewButtons\(\)[\s\S]{0,400}?_syncSlotColorsAvailability\(\)/,
    'la disponibilite ne suit pas les bascules d\'apercu');
});

check('les noms de slot sont echappes avant d\'entrer dans le HTML', () => {
  // Le nom est saisi par l'utilisateur et atterrit dans innerHTML.
  assert.match(MAIN, /function _escapeHtml\(/, '_escapeHtml absente');
  const a = MAIN.indexOf('function renderSlotLegend');
  const body = MAIN.slice(a, MAIN.indexOf('\n}', MAIN.indexOf('slotLegendEl.innerHTML', a)));
  assert.ok(!/\+\s*(e\.slot\.name|slot\.name)/.test(body),
    'un nom de slot entre dans le HTML sans echappement');
  assert.match(body, /_escapeHtml\(e\.slot\.name/, 'le nom de slot n\'est pas echappe');
});

console.log('\n4. Les traductions');

for (const lang of ['en', 'fr', 'de', 'es', 'it', 'pt', 'ja', 'ko']) {
  check(`${lang} porte les cles du mode`, () => {
    const src = readFileSync(join(root, 'js', 'i18n', `${lang}.js`), 'utf8');
    assert.match(src, /"ui\.showSlotColors":/, 'ui.showSlotColors absente');
    assert.match(src, /"ui\.slotLegendNone":/, 'ui.slotLegendNone absente');
    assert.match(src, /"tooltips\.showSlotColors":/, 'tooltips.showSlotColors absente');
  });
}

console.log(`\n${pass} ok, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
