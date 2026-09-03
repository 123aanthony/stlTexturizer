// EXPORT EN LIGNE DE COMMANDE — invariants.
//
// Le pipeline lui-meme est deja couvert par le golden. Ce qui est NEUF ici,
// c'est la RECONSTRUCTION du projet : lire l'archive, retrouver les cartes,
// restaurer les selections, rebrancher les reglages. Chaque maillon de cette
// reconstruction peut echouer EN SILENCE — un slot ignore, des niveaux de carte
// oublies, un preset introuvable — et rendre un STL parfaitement valide qui
// n'est pas celui que l'application aurait ecrit.
//
// ⚠️ L'invariant central n'est donc pas « ca sort un fichier » mais « ca sort le
// MEME fichier que la GUI ». On ne peut pas le prouver en comparant a un export
// GUI (il passe par une boite de dialogue native), alors on le tient par
// CONSTRUCTION — tout est partage avec l'app, jusqu'aux octets du STL — et on
// verifie ici que chaque entree reconstruite ARRIVE bien au moteur.

import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { PNG } from 'pngjs';
import * as THREE from 'three';

import { exportProject, geometryFromSTL } from '../scripts/bumpforge-export.mjs';
import { buildSTLBuffer } from '../js/exporter.js';
import { auditEdges } from '../js/printAudit.js';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

const DIR = mkdtempSync(join(tmpdir(), 'bumpforge-cli-'));

// ── Fabrique de projet ───────────────────────────────────────────────────────

function boxGeometry(sx, sy, sz) {
  const P = {
    a: [0,0,0], b: [sx,0,0], c: [sx,sy,0], d: [0,sy,0],
    e: [0,0,sz], f: [sx,0,sz], g: [sx,sy,sz], h: [0,sy,sz],
  };
  const quads = [['e','f','g','h'], ['d','c','b','a'], ['a','b','f','e'],
                 ['c','d','h','g'], ['b','c','g','f'], ['d','a','e','h']];
  const out = [];
  for (const [k0,k1,k2,k3] of quads) {
    out.push(...P[k0], ...P[k1], ...P[k2], ...P[k0], ...P[k2], ...P[k3]);
  }
  const pos = new Float32Array(out);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Petite carte PNG en data URL, avec du contraste (sinon rien ne se deplace). */
function mapDataUrl(w = 32, h = 32) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) << 2;
    const v = ((x >> 2) + (y >> 2)) % 2 ? 230 : 25;
    png.data[i] = png.data[i+1] = png.data[i+2] = v;
    png.data[i+3] = 255;
  }
  return 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
}

const REGLAGES_SLOT = {
  mappingMode: 5, scaleU: 10, scaleV: 10, scaleUnit: 'mm', offsetU: 0, offsetV: 0,
  rotation: 0, amplitude: 0.6, textureHeight: 0.6, symmetricDisplacement: true,
  bottomAngleLimit: 0, topAngleLimit: 0, mappingBlend: 0, seamBandWidth: 0.35,
  textureSmoothing: 0, blendNormalSmoothing: 0, seamBlendWidthMm: 0,
  boundaryFalloff: 0, noDownwardZ: false,
  mapBlack: 0, mapWhite: 1, mapGamma: 1, mapMacro: 1, mapMicro: 1, mapSplitMm: 1,
  pieceOffset: 0, pieceRotate: 0, pieceFlip: false, pieceSeed: 1,
};

/**
 * Ecrit un .bforge minimal mais REEL (meme format que l'app).
 * @param over.slots  surcharges par slot
 * @param over.global surcharges des reglages globaux du payload
 */
function makeProject(nom, { slots = [{}], global = {}, sansModele = false } = {}) {
  const geo = boxGeometry(20, 20, 4);
  const triCount = geo.attributes.position.count / 3;
  const url = mapDataUrl();

  const payload = {
    version: 1,
    refineLength: 1.0, maxTriangles: 2_000_000, textureAntialias: false,
    displayCreaseAngle: 30, decimateEnabled: false,
    textureSmoothing: 0,
    textureSlots: slots.map((o, i) => ({
      id: `slot${i + 1}`,
      name: o.name || `Slot ${i + 1}`,
      activeMapType: o.presetName ? 'preset' : 'custom',
      presetName: o.presetName || null,
      activeMapName: o.presetName || 'carte.png',
      customMapName: o.presetName ? null : 'carte.png',
      customMapDataUrl: o.presetName ? null : url,
      selectionMode: true,
      // Toutes les faces, sauf mention contraire : une selection vide est un
      // cas a part, teste separement.
      excludedFaces: o.faces === null ? [] : (o.faces || [...Array(triCount).keys()]),
      settings: { ...REGLAGES_SLOT, ...(o.settings || {}) },
    })),
    ...global,
  };

  const entries = { 'settings.json': strToU8(JSON.stringify(payload)) };
  if (!sansModele) entries['model.stl'] = new Uint8Array(buildSTLBuffer(geo));
  const p = join(DIR, nom);
  writeFileSync(p, Buffer.from(zipSync(entries)));
  return { path: p, geo, triCount };
}

console.log('\n1. Aller-retour STL : ce qu on ecrit, on sait le relire');

await check('lecteur et ecrivain se repondent au flottant pres', () => {
  // Le lecteur de la CLI et l'ecrivain de l'app doivent decrire le MEME format.
  const g = boxGeometry(13, 7, 3);
  const relu = geometryFromSTL(new Uint8Array(buildSTLBuffer(g)));
  const A = g.attributes.position.array, B = relu.attributes.position.array;
  assert.equal(A.length, B.length, 'compte de sommets different apres aller-retour');
  let maxd = 0;
  for (let i = 0; i < A.length; i++) maxd = Math.max(maxd, Math.abs(A[i] - B[i]));
  assert.ok(maxd === 0, `ecart max ${maxd} — le STL est en float32 des deux cotes, il doit etre EXACT`);
});

console.log('\n2. Un projet reel traverse le moteur');

await check('un .bforge a un slot rend une geometrie deplacee', async () => {
  const { path, triCount } = makeProject('simple.bforge');
  const r = await exportProject(path);
  const out = r.geometry.attributes.position.count / 3;
  assert.ok(out > triCount, `sortie ${out} triangles pour ${triCount} en entree : rien n a ete subdivise`);
  assert.equal(r.slots.length, 1);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.audit, 'aucun audit rendu');
  assert.equal(r.edges.triCount, out, 'l audit ne porte pas sur la geometrie rendue');
});

await check('deux exports du MEME projet sont identiques', async () => {
  // Un lot qui rendrait deux fichiers differents pour le meme projet serait
  // inutilisable : on ne pourrait plus dire si un reglage a change quelque chose.
  const { path } = makeProject('deterministe.bforge');
  const a = (await exportProject(path)).geometry.attributes.position.array;
  const b = (await exportProject(path)).geometry.attributes.position.array;
  assert.equal(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert.equal(diff, 0, `${diff} sommets differents entre deux exports du meme projet`);
});

await check('deux slots : chacun sa selection, tout est bati', async () => {
  const N = 12;                       // la boite : 6 quads, 2 triangles chacun
  const { path, triCount } = makeProject('deux.bforge', {
    slots: [
      { name: 'haut', faces: [...Array(N).keys()].filter(i => i % 2 === 0) },
      { name: 'bas',  faces: [...Array(N).keys()].filter(i => i % 2 === 1) },
    ],
  });
  assert.equal(triCount, N, 'la boite d epreuve n a plus 12 triangles');
  const r = await exportProject(path);
  assert.equal(r.slots.length, 2, 'un slot a ete perdu');
  assert.ok(r.geometry.attributes.position.count / 3 > triCount);
});

console.log('\n3. Les reglages ARRIVENT au moteur (le defaut silencieux a craindre)');

await check('les niveaux de carte (mapPrep) changent VRAIMENT la sortie', async () => {
  // ⚠️ C'est l'invariant le plus important de ce fichier. Si la CLI oubliait la
  // preparation de carte, elle rendrait un STL parfaitement valide — et une
  // matiere differente de celle de l'ecran, sans un mot.
  const neutre = makeProject('prep-neutre.bforge');
  const prepare = makeProject('prep-actif.bforge', {
    slots: [{ settings: { mapBlack: 0.25, mapWhite: 0.75 } }],
  });
  const a = (await exportProject(neutre.path)).geometry.attributes.position.array;
  const b = (await exportProject(prepare.path)).geometry.attributes.position.array;
  assert.equal(a.length, b.length, 'la preparation ne doit pas changer la TOPOLOGIE');
  let diff = 0, maxd = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 1e-9) { diff++; maxd = Math.max(maxd, d); }
  }
  assert.ok(diff > 0, 'les niveaux de carte n ont AUCUN effet : mapPrep n est pas cable');
  console.log(`       ${diff} sommets deplaces, ecart max ${maxd.toFixed(3)} mm`);
});

await check('l amplitude change la sortie (les reglages du SLOT sont lus)', async () => {
  const faible = makeProject('amp-faible.bforge', { slots: [{ settings: { amplitude: 0.1 } }] });
  const forte  = makeProject('amp-forte.bforge',  { slots: [{ settings: { amplitude: 1.5 } }] });
  const a = (await exportProject(faible.path)).geometry;
  const b = (await exportProject(forte.path)).geometry;
  a.computeBoundingBox(); b.computeBoundingBox();
  const ea = a.boundingBox.max.z - a.boundingBox.min.z;
  const eb = b.boundingBox.max.z - b.boundingBox.min.z;
  assert.ok(eb > ea + 0.1, `amplitude sans effet : hauteurs ${ea.toFixed(3)} et ${eb.toFixed(3)}`);
});

await check('un preset est retrouve par son NOM affiche', async () => {
  // La correspondance nom -> fichier vit dans IMAGE_PRESETS ; une table
  // recopiee dans la CLI se perimerait au premier preset ajoute.
  const { path } = makeProject('preset.bforge', { slots: [{ presetName: 'Brick' }] });
  const r = await exportProject(path);
  assert.equal(r.slots.length, 1);
  assert.ok(r.geometry.attributes.position.count > 0);
});

console.log('\n4. Ce qui doit ECHOUER, et le dire');

await check('textureSmoothing > 0 : REFUS explicite, pas une approximation', async () => {
  // Le flou est un filtre Canvas2D. Rendre un fichier « presque » juste serait
  // pire que ne rien rendre — un lot batch se juge sur la fidelite.
  const { path } = makeProject('flou.bforge', { slots: [{ settings: { textureSmoothing: 3 } }] });
  await assert.rejects(() => exportProject(path), (e) => {
    assert.match(e.message, /textureSmoothing/, 'le refus ne nomme pas le reglage en cause');
    assert.match(e.message, /GUI|app/i, 'le refus ne propose aucun remede');
    return true;
  });
});

await check('archive sans modele : message clair', async () => {
  const { path } = makeProject('sans-modele.bforge', { sansModele: true });
  await assert.rejects(() => exportProject(path), /model\.stl/);
});

await check('projet sans slot : message clair', async () => {
  const { path } = makeProject('sans-slot.bforge', { slots: [] });
  await assert.rejects(() => exportProject(path), /slot/i);
});

await check('un slot sans selection est ANNONCE, pas avale', async () => {
  // Le pire cas : un slot ignore en silence rendrait un modele partiellement
  // texture qui a l air fini.
  const { path, triCount } = makeProject('vide.bforge', {
    slots: [{ name: 'plein' }, { name: 'vide', faces: null }],
  });
  const r = await exportProject(path);
  assert.equal(r.slots.length, 1, 'le slot vide aurait du etre ecarte');
  assert.equal(r.warnings.length, 1, 'le slot ecarte n a pas ete annonce');
  assert.match(r.warnings[0], /vide/, 'l avertissement ne nomme pas le slot');
});

console.log('\n5. L audit accompagne l export');

await check('l audit rendu est celui de la geometrie ecrite', async () => {
  const { path } = makeProject('audit.bforge');
  const r = await exportProject(path);
  const direct = auditEdges(r.geometry);
  assert.equal(r.edges.open, direct.open);
  assert.equal(r.edges.nonManifold, direct.nonManifold);
  assert.equal(r.edges.edgeCount, direct.edgeCount);
});

await check('le creux REEL des cartes est mesure (la borne n est plus un majorant)', async () => {
  // La CLI a l'ImageData sous la main : elle n'a aucune raison de supposer le
  // noir absolu, contrairement a l'app aujourd'hui.
  const { path } = makeProject('borne.bforge');
  const r = await exportProject(path);
  assert.equal(r.inward.exact, true,
    'la CLI devrait mesurer greyMin, pas se rabattre sur le majorant');
});

rmSync(DIR, { recursive: true, force: true });
console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
