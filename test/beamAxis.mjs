// Validates the PCA beam-axis detection (js/beamAxis.js): the long axis must be
// found regardless of world orientation — that's the whole point vs Wood Auto.

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { computeBeamFrame, orientedRawUV } from '../js/beamAxis.js';

let passed = 0;
function test(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

function beamPositions(angleDeg = 0, axis = 'y') {
  const g = new THREE.BoxGeometry(90, 14, 14, 18, 3, 3);
  if (angleDeg) (axis === 'y' ? g.rotateY : g.rotateZ).call(g, angleDeg * Math.PI / 180);
  return g.toNonIndexed().attributes.position.array;
}
const adot = (a, b) => Math.abs(a[0]*b[0] + a[1]*b[1] + a[2]*b[2]);

test('PCA: straight beam → long axis ≈ world X', () => {
  const f = computeBeamFrame(beamPositions(0));
  assert.ok(adot(f.U, [1, 0, 0]) > 0.99, `U=${f.U}`);
});

test('PCA: beam tilted 35° about Y → long axis follows the tilt', () => {
  const a = 35 * Math.PI / 180;
  const f = computeBeamFrame(beamPositions(35, 'y'));
  assert.ok(adot(f.U, [Math.cos(a), 0, -Math.sin(a)]) > 0.99, `U=${f.U}`);
});

test('PCA: beam tilted 50° about Z → long axis follows the tilt', () => {
  const a = 50 * Math.PI / 180;
  const f = computeBeamFrame(beamPositions(50, 'z'));
  assert.ok(adot(f.U, [Math.cos(a), Math.sin(a), 0]) > 0.99, `U=${f.U}`);
});

test('oriented: rawU increases along the beam axis (any orientation)', () => {
  const f = computeBeamFrame(beamPositions(35, 'y'));
  const c = f.center;
  const p0 = { x: c[0], y: c[1], z: c[2] };
  const p1 = { x: c[0] + f.U[0]*10, y: c[1] + f.U[1]*10, z: c[2] + f.U[2]*10 };
  const n = { x: f.W[0], y: f.W[1], z: f.W[2] }; // a side normal
  assert.ok(orientedRawUV(p1, n, f).rawU > orientedRawUV(p0, n, f).rawU);
});

test('oriented: face normal selects the cross-axis (top face vs side face)', () => {
  // Classification is by the FACE normal. On the export mesh normals are split
  // per-face at sharp edges, so a top-face point (normal ∥ W) and a side-face
  // point (normal ∥ V) map V to DIFFERENT cross-coordinates — that's what makes
  // the grain run lengthwise on every face. (The earlier "normal-independent"
  // guard was wrong: it assumed a fan that was actually a smooth-normal test
  // artefact; the real subdivided mesh has per-face normals.)
  const f = computeBeamFrame(beamPositions(0));
  const c = f.center;
  const p = { // off-axis: distinct V (3) and W (2) offsets so the two branches differ
    x: c[0] + f.V[0]*3 + f.W[0]*2, y: c[1] + f.V[1]*3 + f.W[1]*2, z: c[2] + f.V[2]*3 + f.W[2]*2,
  };
  const nW = { x: f.W[0], y: f.W[1], z: f.W[2] }; // top face  → V follows the V-offset
  const nV = { x: f.V[0], y: f.V[1], z: f.V[2] }; // side face → V follows the W-offset
  assert.notEqual(orientedRawUV(p, nW, f).rawV, orientedRawUV(p, nV, f).rawV);
  // W-normal (top): rawV tracks lvc≈3/md ; V-normal (side): rawV tracks lwc≈2/md
  assert.ok(orientedRawUV(p, nW, f).rawV > orientedRawUV(p, nV, f).rawV);
});

test('PCA masked to a beam inside a larger model → beam axis, not model axis', () => {
  const slab = new THREE.BoxGeometry(40, 146, 8, 1, 1, 1).toNonIndexed();   // model long in Y
  const beam = new THREE.BoxGeometry(60, 10, 10, 1, 1, 1).toNonIndexed();   // beam long in X
  beam.translate(0, 0, 20);
  const sp = slab.attributes.position.array, bp = beam.attributes.position.array;
  const all = new Float32Array(sp.length + bp.length);
  all.set(sp, 0); all.set(bp, sp.length);
  const slabTris = sp.length / 9, beamTris = bp.length / 9;
  const mask = new Uint8Array(slabTris + beamTris);
  for (let t = slabTris; t < slabTris + beamTris; t++) mask[t] = 1; // only the beam

  assert.ok(adot(computeBeamFrame(all).U, [0, 1, 0]) > 0.9, 'whole-model axis should be ~Y');
  assert.ok(adot(computeBeamFrame(all, mask).U, [1, 0, 0]) > 0.9, 'masked axis should be ~X (the beam)');
});


// ── Régression : le frame de l'export mono-slot vient de la SÉLECTION ────────
// (bug vécu : echec.bforge — poutres sélectionnées dans un compound FreeCAD,
// « Exporter STL » calculait la PCA sur le bâtiment entier → vagues géantes
// dans l'axe du bâtiment. Le masque doit se dériver des exclude-weights.)
import { triMaskFromExcludeWeight } from '../js/beamAxis.js';

function compositeScene() {
  // grande plaque (l'axe dominant du MODÈLE) + poutre le long de Y (la sélection)
  const plate = new THREE.BoxGeometry(200, 40, 4, 1, 1, 1).toNonIndexed();
  const beam = new THREE.BoxGeometry(12, 90, 12, 1, 1, 1).toNonIndexed();
  beam.translate(60, 0, 30);
  const p1 = plate.attributes.position.array, p2 = beam.attributes.position.array;
  const pos = new Float32Array(p1.length + p2.length);
  pos.set(p1); pos.set(p2, p1.length);
  // exclude-weights : plaque exclue (1), poutre incluse (0)
  const ew = new Float32Array(pos.length / 3).fill(0);
  for (let v = 0; v < p1.length / 3; v++) ew[v] = 1;
  return { pos, ew, plateVerts: p1.length / 3 };
}

test('exclude-weights → masque PCA : la poutre, pas la plaque', () => {
  const { pos, ew } = compositeScene();
  const mask = triMaskFromExcludeWeight(ew, pos.length / 3);
  assert.ok(mask, 'masque attendu (la plaque est exclue)');
  const f = computeBeamFrame(pos, mask);
  assert.ok(adot(f.U, [0, 1, 0]) > 0.99, `U=${f.U} (attendu : axe Y de la poutre)`);
  assert.ok(Math.abs(f.md - 90) < 1, `md=${f.md} (attendu : longueur de la poutre)`);
});

test('sans masque, la PCA suivrait la plaque (le bug d\'avant)', () => {
  const { pos } = compositeScene();
  const f = computeBeamFrame(pos, null);
  assert.ok(adot(f.U, [1, 0, 0]) > 0.9, `U=${f.U} (le modèle entier domine en X)`);
});

test('rien d\'exclu → null (modèle entier = la pièce, chemin legacy intact)', () => {
  const ew = new Float32Array(90).fill(0);
  assert.equal(triMaskFromExcludeWeight(ew, 90), null);
});

test('BufferAttribute accepté (le chemin réel passe l\'attribut)', () => {
  const { pos, ew } = compositeScene();
  const attr = new THREE.BufferAttribute(ew, 1);
  const mask = triMaskFromExcludeWeight(attr, pos.length / 3);
  const f = computeBeamFrame(pos, mask);
  assert.ok(adot(f.U, [0, 1, 0]) > 0.99, `U=${f.U}`);
});


// ── Échelle PHYSIQUE en Bois auto (retour PO : « je retweake échelle+lissage
// par poutre, même en copiant le slot ») : la même échelle doit donner le
// MÊME grain en mm sur une poutre longue et une courte. computeUV normalise
// par le md GLOBAL du modèle, plus par l'étendue de la sélection.
import { computeUV, MODE_WOOD_AUTO } from '../js/mapping.js';

test('mode 7 : Δu par mm identique sur poutre longue et courte (échelle physique)', () => {
  const longBeam = new THREE.BoxGeometry(90, 10, 10, 1, 1, 1).toNonIndexed();
  const shortBeam = new THREE.BoxGeometry(30, 10, 10, 1, 1, 1).toNonIndexed();
  const fLong = computeBeamFrame(longBeam.attributes.position.array);
  const fShort = computeBeamFrame(shortBeam.attributes.position.array);
  const bounds = {
    min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 },
    size: { x: 200, y: 200, z: 200 }, center: { x: 0, y: 0, z: 0 },
  };
  const st = (frame) => ({ scaleU: 1, scaleV: 1, offsetU: 0, offsetV: 0, beamFrame: frame });
  const n = { x: 0, y: 0, z: 1 };                      // face du dessus
  const du = (frame, x1, x2) => {
    const a = computeUV({ x: x1, y: 0, z: 5 }, n, MODE_WOOD_AUTO, st(frame), bounds);
    const b = computeUV({ x: x2, y: 0, z: 5 }, n, MODE_WOOD_AUTO, st(frame), bounds);
    return Math.abs(b.u - a.u);
  };
  const duLong = du(fLong, 0, 10), duShort = du(fShort, 0, 10);
  assert.ok(Math.abs(duLong - duShort) < 1e-6,
    `10 mm doivent couvrir le même Δu partout : long=${duLong}, court=${duShort}`);
  assert.ok(Math.abs(duLong - 10 / 200) < 1e-6,
    `Δu attendu = 10/md_global = 0.05, obtenu ${duLong}`);
});

console.error(`\nbeamAxis: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
