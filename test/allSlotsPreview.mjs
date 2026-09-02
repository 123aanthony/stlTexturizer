// L'APERCU « TOUS LES SLOTS » MONTRE-T-IL CE QUE L'EXPORT ECRIRA ?
//
// LE DEFAUT (rapporte en GUI : « les rendus sont differents en apercu de slot
// et en apercu de tous les slots »)
// ---------------------------------------------------------------------------
// `rebuildAllSlotsPreview` construisait sa vue en appelant, une fois PAR SLOT,
// `buildExportGeometryForSlot` — un constructeur qui ne rend PAS les seuls
// triangles du slot : il subdivise et rend le MAILLAGE ENTIER, en ne deplacant
// que les faces assignees. Concatener N slots empilait donc N COPIES COMPLETES
// du modele.
//
// POURQUOI CA SE VOIT — ET PAS EN APERCU D'UN SEUL SLOT
// -----------------------------------------------------
// Le deplacement est SIGNE et centre sur le gris moyen (displacement.js, en
// tete : « (grey - 0.5) x 2 x amplitude »). Une copie NON deplacee se pose donc
// au MILIEU du relief, pas dessous : elle rebouche tous les creux et z-fight
// avec tout ce qui frole le gris moyen. Avec UN seul slot il n'y a aucune copie
// parasite — d'ou l'ecart entre les deux vues.
//
// CE QUE CE FICHIER PROUVE
// ------------------------
//   §1 CABLAGE — le source de main.js emprunte reellement le pipeline d'export
//      sur la branche « tous les slots » (verifie sur du code DEBARRASSE de ses
//      commentaires : ce fichier-ci cite les noms de fonction dans les siens).
//   §2 MECANISME — sur le VRAI pipeline, en chiffres : le chemin d'export rend
//      UNE surface, l'ancien empilement en rendait N, dont N-1 au nu qui
//      enterrent le relief. C'est la mesure qui rend l'oracle vivant : elle
//      echoue si l'on revient a l'ancienne construction.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { subdivide } from '../js/subdivision.js';
import { applyDisplacement } from '../js/displacement.js';
import { computeBounds, baseSettings, legacyRelToMm, runMultiSlot } from './lib/pipeline.mjs';

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

// ── §1 Cablage ───────────────────────────────────────────────────────────────
// Comme dans previewParity.mjs : on retire les commentaires AVANT de chercher.
// Un oracle qui ne distingue pas le code du commentaire ne prouve rien — et ce
// fichier-ci nomme justement les deux fonctions dans son propre en-tete.
const MAIN = readFileSync(join(here, '..', 'js', 'main.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/.*/g, ' ');

console.log('\n1. L\'apercu « tous les slots » emprunte le pipeline d\'export');

const fnStart = MAIN.indexOf('async function rebuildAllSlotsPreview');
const fnEnd   = MAIN.indexOf('function exitAllSlotsPreview', fnStart);
const BODY    = fnStart >= 0 && fnEnd > fnStart ? MAIN.slice(fnStart, fnEnd) : '';

check('rebuildAllSlotsPreview est bien trouvee dans le source', () => {
  assert.ok(BODY.length > 0, 'corps de rebuildAllSlotsPreview introuvable');
});

check('la branche « all » appelle buildExportGeometryForAllSlots', () => {
  const iScope = BODY.indexOf("previewScope === 'all'");
  const iAll   = BODY.indexOf('buildExportGeometryForAllSlots');
  assert.ok(iScope >= 0, "pas de branche previewScope === 'all'");
  assert.ok(iAll > iScope,
    'buildExportGeometryForAllSlots n\'est pas appele dans la branche « tous les slots »');
});

check('la boucle par slot est reservee a l\'apercu d\'UN slot', () => {
  const iAll  = BODY.indexOf('buildExportGeometryForAllSlots');
  const iElse = BODY.indexOf('} else {', iAll);
  const iPer  = BODY.indexOf('buildExportGeometryForSlot(');
  assert.ok(iElse > iAll, 'pas de branche else apres l\'appel multi-slot');
  assert.ok(iPer > iElse,
    'buildExportGeometryForSlot reste sur le chemin « tous les slots » : l\'empilement est de retour');
});

check('un export en cours n\'est pas avorte par l\'apercu', () => {
  // L'apercu prend desormais le JETON d'annulation de l'export ; sans ce garde
  // il annulerait l'export en cours au premier clic.
  assert.match(BODY, /isExporting/,
    'rebuildAllSlotsPreview ne se garde pas contre un export en cours');
});

// ── §2 Mecanisme, sur le vrai pipeline ───────────────────────────────────────
console.log('\n2. Une seule surface, et le relief n\'est pas enterre');

/** Plaque plate (normale +Z) de n x n quads, non indexee. */
function plate(n = 6, size = 30) {
  const tris = [];
  const s = size / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x0 = -size / 2 + i * s, x1 = x0 + s;
      const y0 = -size / 2 + j * s, y1 = y0 + s;
      tris.push([[x0, y0, 0], [x1, y0, 0], [x1, y1, 0]]);
      tris.push([[x0, y0, 0], [x1, y1, 0], [x0, y1, 0]]);
    }
  }
  const pos = new Float32Array(tris.length * 9);
  const nrm = new Float32Array(tris.length * 9);
  tris.forEach((t, k) => {
    for (let v = 0; v < 3; v++) {
      pos[k * 9 + v * 3]     = t[v][0];
      pos[k * 9 + v * 3 + 1] = t[v][1];
      pos[k * 9 + v * 3 + 2] = t[v][2];
      nrm[k * 9 + v * 3 + 2] = 1;
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal',   new THREE.BufferAttribute(nrm, 3));
  return g;
}

/** Carte UNIE : gris constant. 0 = tout le relief part VERS L'INTERIEUR. */
function flatMap(grey, width = 32, height = 32) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = grey;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

/** Part des sommets restes AU NU (z ~ 0), la ou le relief devrait les avoir creuses. */
function fracAtBase(geo, tol = 1e-3) {
  const p = geo.attributes.position.array;
  let at = 0, n = 0;
  for (let i = 2; i < p.length; i += 3) { n++; if (Math.abs(p[i]) <= tol) at++; }
  return at / n;
}

const REFINE = 2.0;
const AMP = 2.0;
// symmetricDisplacement:true (le defaut) = deplacement SIGNE des deux cotes du gris
// moyen. A false, un gris 0 ne creuse rien (mesure : plage z 0.0000) et le cas ne
// dirait plus rien.
const SETTINGS = { ...baseSettings, amplitude: AMP };
const BLACK = flatMap(0);

// Deux slots qui se partagent la plaque : moitie gauche / moitie droite.
const ownerOf = (_t, c) => (c.x < 0 ? 0 : 1);

let newTris = 0;

await checkAsync('chemin d\'EXPORT : une seule surface, tout le relief creuse', async () => {
  const geo = plate();
  const out = await runMultiSlot(geo, {
    refineLength: REFINE,
    maxTriangles: null,
    slots: [{ texture: BLACK, settings: SETTINGS }, { texture: BLACK, settings: SETTINGS }],
    assignOriginal: ownerOf,
  });
  newTris = out.attributes.position.count / 3;
  const base = fracAtBase(out);
  console.log(`       ${newTris} triangles, ${(base * 100).toFixed(1)} % des sommets restes au nu`);
  assert.ok(base < 0.05,
    `le relief est enterre sur ${(base * 100).toFixed(1)} % des sommets (attendu < 5 %)`);
});

await checkAsync('ANCIENNE construction : N copies, la moitie des sommets au nu', async () => {
  // Reproduction FIDELE de la boucle supprimee : une construction par slot sur
  // le maillage ENTIER (masque = les seules faces du slot), puis concatenation.
  const geo = plate();
  const bounds = computeBounds(geo);
  const settings = legacyRelToMm(SETTINGS, bounds);
  const assigned = [new Set(), new Set()];
  const p0 = geo.attributes.position.array;
  for (let t = 0; t < p0.length / 9; t++) {
    const cx = (p0[t * 9] + p0[t * 9 + 3] + p0[t * 9 + 6]) / 3;
    assigned[cx < 0 ? 0 : 1].add(t);
  }

  let total = 0, atBase = 0, verts = 0;
  for (const owned of assigned) {
    const { geometry: sub, faceParentId } = await subdivide(geo, REFINE, null, null);
    const faceMask = new Uint8Array(faceParentId.length);
    for (let s = 0; s < faceParentId.length; s++) faceMask[s] = owned.has(faceParentId[s]) ? 1 : 0;
    const disp = applyDisplacement(sub, BLACK, BLACK.width, BLACK.height,
      { ...settings, faceMask }, bounds, null);
    total += disp.attributes.position.count / 3;
    const arr = disp.attributes.position.array;
    for (let i = 2; i < arr.length; i += 3) { verts++; if (Math.abs(arr[i]) <= 1e-3) atBase++; }
  }

  const base = atBase / verts;
  console.log(`       ${total} triangles (${(total / newTris).toFixed(2)}x), ` +
              `${(base * 100).toFixed(1)} % des sommets restes au nu`);
  assert.ok(total >= 1.9 * newTris,
    `l'empilement devrait doubler les triangles (${total} vs ${newTris})`);
  assert.ok(base > 0.40,
    `la moitie des sommets devrait rester au nu, mesure ${(base * 100).toFixed(1)} %`);
});

console.log(`\n${pass} ok, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
